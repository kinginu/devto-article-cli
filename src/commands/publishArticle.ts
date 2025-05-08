// src/commands/publishArticle.ts
import path from 'path';
import fs from 'fs/promises';
import matter from 'gray-matter';
import logger from '../utils/logger.js';
// Import the A+C file getter function and the new gitAddAll
import { gitAddAll, gitCommit, gitPush, getRepoInfo, getPublishableMarkdownFiles } from '../utils/gitHelper.js';
import { createArticle, updateArticle } from '../utils/devtoApi.js';
import type { DevToArticlePayload } from '../utils/devtoApi.js';
// readFileContent is not used directly here if fs.readFile is used for initial read.
// import { readFileContent } from '../utils/fileHelper.js';
import { convertLocalPathsToGitHubUrls } from '../utils/imageHandler.js';

// Configuration: Default articles directory.
const ARTICLES_DIR_NAME = 'articles';
// ARTICLES_DIR_PATH is not used in the current logic, relative paths from repo root are preferred.
// const ARTICLES_DIR_PATH = path.join(process.cwd(), ARTICLES_DIR_NAME);

interface PublishResult {
    file: string; // Relative path from repo root
    success: boolean;
    url?: string;
    id?: number;
    error?: string;
    skipped?: boolean; // Flag for skipped files
    action?: 'created' | 'updated' | 'failed' | 'skipped';
}

export async function publishArticle(): Promise<void> {
  logger.info('Starting article publishing process...');

  // 1. Get Git Repo Info
  let repoInfo;
  try {
      repoInfo = await getRepoInfo();
      if (!repoInfo.user || !repoInfo.repo || !repoInfo.branch) {
          throw new Error('Could not determine GitHub repository details (user, repo, branch). Ensure remote origin is set or GITHUB_REPOSITORY env var is available.');
      }
      logger.debug('GitHub Repo Info:', repoInfo);
  } catch(error) {
      logger.error(`Failed to get Git repository info: ${error instanceof Error ? error.message : String(error)}`);
      logger.info('Publishing process aborted due to missing repository information.');
      return; // Abort if repo info is critical and missing
  }

  // 2. Get publishable files (Changed vs Remote OR Local Status Changed)
  let publishableFiles;
  try {
    // Use the A+C logic function, ARTICLES_DIR_NAME should be relative path from repo root
    publishableFiles = await getPublishableMarkdownFiles(ARTICLES_DIR_NAME);
  } catch (error) {
    logger.error(`Failed to determine publishable files: ${error instanceof Error ? error.message : String(error)}`);
    return; // Abort if cannot determine files
  }

  if (publishableFiles.length === 0) {
    logger.info(`No Markdown files found in '${ARTICLES_DIR_NAME}' that have local changes or are different from the remote branch. Nothing to publish.`);
    return;
  }

  logger.info(`Found ${publishableFiles.length} Markdown file(s) to process (new/modified locally or changed vs remote):`);
  publishableFiles.forEach(f => logger.info(` - ${f}`));


  const results: PublishResult[] = [];
  // Removed: const filesToGitAdd = new Set<string>(); // No longer needed for selective add

  // 3. Process each publishable file
  for (const relativeFilePath of publishableFiles) {
    // Ensure absoluteFilePath is correctly derived if needed, but relativeFilePath is used for most ops
    const absoluteFilePath = path.join(process.cwd(), relativeFilePath);
    logger.info(`Processing: ${relativeFilePath}`);
    try {
      const fileContentString = await fs.readFile(absoluteFilePath, 'utf8');
      let { data: frontMatter, content: body_markdown } = matter(fileContentString);

      if (!frontMatter.title) {
        logger.warn(`Skipping ${relativeFilePath}: 'title' is missing in front-matter.`);
        results.push({ file: relativeFilePath, success: false, error: 'Missing title', skipped: true, action: 'skipped' });
        continue;
      }

      // Convert local image paths to GitHub URLs before sending to Dev.to
      const markdownForDevto = await convertLocalPathsToGitHubUrls(
          body_markdown,
          relativeFilePath, // Pass the relative path of the markdown file from repo root
          repoInfo // Pass the full repoInfo object
      );

      let articleUrl: string | undefined;
      // Ensure dev_to_article_id is treated as a number if it exists
      let articleId: number | null | undefined = frontMatter.dev_to_article_id ? parseInt(String(frontMatter.dev_to_article_id), 10) : null;
      if (articleId !== null && isNaN(articleId)) { // Check if parsing resulted in NaN
          logger.warn(`Invalid dev_to_article_id "${frontMatter.dev_to_article_id}" in ${relativeFilePath}. Treating as new article.`);
          articleId = null;
      }


      const payloadForApi: DevToArticlePayload = {
        article: {
          title: frontMatter.title as string,
          body_markdown: markdownForDevto, // Use content with converted image paths
          published: frontMatter.published === undefined ? false : frontMatter.published, // Default to false if not set
          tags: frontMatter.tags || [],
          series: frontMatter.series || null,
          main_image: frontMatter.main_image || null,
          canonical_url: frontMatter.canonical_url || null,
          description: frontMatter.description || '', // Default to empty string if not set
          organization_id: frontMatter.organization_id || null,
        }
      };

      if (articleId) {
        // Update existing article
        logger.info(`Updating article ID ${articleId} for ${relativeFilePath}...`);
        const updatedArticle = await updateArticle(articleId, payloadForApi);
        articleUrl = updatedArticle.url;
        logger.success(`Article updated on Dev.to: ${articleUrl}`);
        // No need to add to filesToGitAdd, gitAddAll() will handle it
        results.push({ file: relativeFilePath, success: true, url: articleUrl, id: articleId as number, action: 'updated' });
      } else {
        // Create new article
        logger.info(`Publishing ${relativeFilePath} as a new article...`);
        const newArticleData = await createArticle(payloadForApi);
        articleId = newArticleData.id;
        articleUrl = newArticleData.url;

        // Add/update dev_to_article_id in the local file's front-matter
        frontMatter.dev_to_article_id = articleId;
        // Re-stringify with original body_markdown (not markdownForDevto, which is for API)
        // unless image paths were meant to be permanently converted in local files too.
        // Assuming local files should retain their original relative paths.
        // If local files also need updated image paths (unlikely), use markdownForDevto here.
        const newLocalFileContent = matter.stringify(body_markdown, frontMatter);
        await fs.writeFile(absoluteFilePath, newLocalFileContent, 'utf8');
        // frontMatterModifiedInScript = true; // Not strictly needed anymore with gitAddAll
        logger.info(`Article ID ${articleId} added/updated in local file ${relativeFilePath}.`);
        logger.success(`New article published on Dev.to: ${articleUrl}`);
        // No need to add to filesToGitAdd
        results.push({ file: relativeFilePath, success: true, url: articleUrl, id: articleId as number, action: 'created' });
      }

    } catch (error) {
      logger.error(`Error processing file ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ file: relativeFilePath, success: false, error: error instanceof Error ? error.message : String(error), action: 'failed' });
    }
  }

  // 4. Git operations if there were any successful API operations (create/update)
  const successfulApiOperations = results.filter(r => r.success && (r.action === 'created' || r.action === 'updated'));

  if (successfulApiOperations.length > 0) {
    try {
      logger.info('Adding all changes, committing, and pushing to Git...');
      await gitAddAll(); // Use the new function to add all changes

      // Construct a commit message based on successfully processed files
      const commitMessage = `Publish/update articles on Dev.to\n\nProcessed files:\n${successfulApiOperations.map(r => `- ${path.basename(r.file)} (ID: ${r.id}, Action: ${r.action}) -> ${r.url}`).join('\n')}`;
      await gitCommit(commitMessage);
      // logger.info('Changes committed.'); // gitCommit now logs its own success or "nothing to commit"

      logger.info('Pushing changes to remote repository...');
      await gitPush();
      // logger.success('Commit and push to Git completed.'); // gitPush now logs its own success
    } catch (gitError) {
      // Error logging is handled within gitCommit and gitPush, but a general catch here is still good
      logger.error(`Error during Git operations sequence: ${gitError instanceof Error ? gitError.message : String(gitError)}`);
      logger.warn('Publishing/updating to Dev.to might have completed for some articles, but Git operations failed. Please check Git status and commit/push manually if needed.');
    }
  } else {
    // This block is reached if no files were successfully created or updated on Dev.to API.
    // It could also be that all files were skipped or failed before API interaction.
    const nonSkippedFailures = results.filter(r => !r.success && !r.skipped);
    if (publishableFiles.length > 0 && successfulApiOperations.length === 0 && nonSkippedFailures.length === 0 && !results.some(r => r.skipped)) {
        // This case means publishable files were found, but none resulted in a successful API op,
        // nor did they fail in a way that would stop git ops (e.g. all skipped due to missing title is already handled).
        // This might also mean "nothing to commit" if local files weren't changed by ID addition.
        logger.info('No new changes to commit to Git related to Dev.to publishing, or no articles were successfully processed for API operations.');
    } else if (successfulApiOperations.length === 0 && publishableFiles.length > 0) {
         logger.warn('No articles were successfully published or updated on Dev.to that required Git updates, or all attempts failed. Git operations skipped.');
    } else {
        // This case (publishableFiles.length === 0) is handled at the beginning.
        // For clarity, if we reach here it's because successfulApiOperations is 0.
        logger.info('No successful Dev.to API operations to record in Git. Git operations skipped.');
    }
  }

  // 5. Final summary report
  logger.info('\n--- Publishing Results Summary ---');
  results.forEach(r => {
    if (r.success) {
      logger.success(`[${r.action?.toUpperCase()}] ${r.file} -> ${r.url} (ID: ${r.id})`);
    } else if (r.skipped) {
      logger.warn(`[SKIPPED] ${r.file} - ${r.error || 'No title or other pre-check failed.'}`);
    } else {
      logger.error(`[${r.action?.toUpperCase() || 'FAILED'}] ${r.file} - ${r.error}`);
    }
  });
  logger.info('---------------------------------');
  logger.info('Article publishing process finished.');
}