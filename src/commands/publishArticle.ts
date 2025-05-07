// src/commands/publishArticle.ts
import path from 'path';
import fs from 'fs/promises';
import matter from 'gray-matter';
import logger from '../utils/logger.js';
import { gitAdd, gitCommit, gitPush, getRepoInfo, getChangedMarkdownFilesAgainstRemote } from '../utils/gitHelper.js';
// Import functions and the necessary type from devtoApi
import { createArticle, updateArticle } from '../utils/devtoApi.js';
import type { DevToArticlePayload } from '../utils/devtoApi'; // Use 'import type' for types
import { readFileContent } from '../utils/fileHelper.js';
import { convertLocalPathsToGitHubUrls } from '../utils/imageHandler.js';

// Configuration: Default articles directory.
const ARTICLES_DIR_NAME = 'articles';
const ARTICLES_DIR_PATH = path.join(process.cwd(), ARTICLES_DIR_NAME); // Absolute path

interface PublishResult {
    file: string; // Relative path from repo root
    success: boolean;
    url?: string;
    id?: number;
    error?: string;
    skipped?: boolean; // Flag for skipped files
}

export async function publishArticle(): Promise<void> {
  logger.info('Starting article publishing process...');

  // 1. Get Git Repo Info
  let repoInfo;
  try {
      repoInfo = await getRepoInfo();
      if (!repoInfo.user || !repoInfo.repo || !repoInfo.branch) {
          throw new Error('Could not determine GitHub repository details (user, repo, branch). Ensure remote origin is set.');
      }
      logger.debug('GitHub Repo Info:', repoInfo);
  } catch(error) {
      logger.error(`Failed to get Git repository info: ${error instanceof Error ? error.message : String(error)}`);
      return;
  }

  // 2. Get changed Markdown files compared to remote
  let changedFiles;
  try {
    changedFiles = await getChangedMarkdownFilesAgainstRemote(ARTICLES_DIR_NAME);
  } catch (error) {
    logger.error(`Failed to determine changed files: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (changedFiles.length === 0) {
    logger.info(`No changed Markdown files found in '${ARTICLES_DIR_NAME}' compared to the remote branch. Nothing to publish.`);
    return;
  }

  logger.info(`Found ${changedFiles.length} changed Markdown file(s) to process:`);
  changedFiles.forEach(f => logger.info(` - ${f}`));


  const results: PublishResult[] = [];
  const filesToGitAdd = new Set<string>(); // Store relative paths from repo root

  // 3. Process each changed file
  for (const relativeFilePath of changedFiles) {
    const absoluteFilePath = path.join(process.cwd(), relativeFilePath);
    logger.info(`Processing: ${relativeFilePath}`);
    try {
      const fileContent = await fs.readFile(absoluteFilePath, 'utf8');
      let { data: frontMatter, content: body_markdown } = matter(fileContent);

      if (!frontMatter.title) {
        logger.warn(`Skipping ${relativeFilePath}: 'title' is missing in front-matter.`);
        results.push({ file: relativeFilePath, success: false, error: 'Missing title', skipped: true });
        continue;
      }

      // Convert local image paths for Dev.to payload
      const markdownForDevto = await convertLocalPathsToGitHubUrls(
          body_markdown,
          relativeFilePath,
          repoInfo
      );

      let articleUrl: string | undefined;
      let articleId: number | null | undefined = frontMatter.dev_to_article_id;
      let frontMatterModifiedInScript = false;

      // --- Fix Start: Wrap payload data inside 'article' key ---
      const payloadForApi: DevToArticlePayload = {
        article: { // Wrap properties inside the 'article' object
          title: frontMatter.title as string, // Assuming title always exists due to check above
          body_markdown: markdownForDevto,
          published: frontMatter.published === undefined ? false : frontMatter.published, // Default to draft
          tags: frontMatter.tags || [],
          series: frontMatter.series || null,
          main_image: frontMatter.main_image || null,
          canonical_url: frontMatter.canonical_url || null,
          description: frontMatter.description || '',
          organization_id: frontMatter.organization_id || null,
        }
      };
      // --- Fix End ---

      if (articleId) {
        // Update existing article
        logger.info(`Updating article ID ${articleId} for ${relativeFilePath}...`);
        // Pass the correctly structured payload
        const updatedArticle = await updateArticle(articleId, payloadForApi);
        articleUrl = updatedArticle.url;
        logger.success(`Article updated on Dev.to: ${articleUrl}`);
        filesToGitAdd.add(relativeFilePath);
      } else {
        // Create new article
        logger.info(`Publishing ${relativeFilePath} as a new article...`);
         // Pass the correctly structured payload
        const newArticleData = await createArticle(payloadForApi);
        articleId = newArticleData.id;
        articleUrl = newArticleData.url;

        // Add ID to front-matter of the original local file
        frontMatter.dev_to_article_id = articleId;
        // Use original body_markdown (not markdownForDevto) when saving locally
        const newLocalFileContent = matter.stringify(body_markdown, frontMatter);
        await fs.writeFile(absoluteFilePath, newLocalFileContent, 'utf8');
        frontMatterModifiedInScript = true;
        logger.info(`Article ID ${articleId} added to local file ${relativeFilePath}.`);
        logger.success(`New article published on Dev.to: ${articleUrl}`);
        filesToGitAdd.add(relativeFilePath); // Add because front-matter changed
      }
      results.push({ file: relativeFilePath, success: true, url: articleUrl, id: articleId as number }); // Cast id as number after check/assignment

    } catch (error) {
      logger.error(`Error processing file ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ file: relativeFilePath, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 4. Git operations only if there were successful API interactions AND files to add
  const filesToAddArray = Array.from(filesToGitAdd);
  if (filesToAddArray.length > 0) {
    try {
      logger.info('Adding, committing, and pushing changes to Git...');
      await gitAdd(filesToAddArray);
      const commitMessage = `Publish/update articles on Dev.to\n\nProcessed files:\n${results.filter(r => r.success).map(r => `- ${path.basename(r.file)} (ID: ${r.id}) -> ${r.url}`).join('\n')}`;
      await gitCommit(commitMessage); // gitCommit handles "nothing to commit" internally now
      await gitPush();
      logger.success('Commit and push to Git completed.');
    } catch (gitError) {
      // Errors during add or push will be caught here
      logger.error('Error during Git operations:', gitError instanceof Error ? gitError.message : String(gitError));
      logger.warn('Publishing/updating to Dev.to might have completed, but recording to Git failed. Please check Git status and commit/push manually if needed.');
    }
  } else {
    logger.warn('No files required Git updates (either no changes detected initially or API processing failed for all changed files). Git operations skipped.');
  }

  // 5. Final summary report
  logger.info('\n--- Publishing Results Summary ---');
  results.forEach(r => {
    if (r.success) {
      logger.success(`[SUCCESS] ${r.file} -> ${r.url}`);
    } else if (!r.skipped) { // Don't report skipped files as failures here
      logger.error(`[FAILED] ${r.file} - ${r.error}`);
    }
  });
  logger.info('---------------------------------');
}
