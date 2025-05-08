// src/commands/publishArticle.ts
import path from 'path';
import fs from 'fs/promises';
import matter from 'gray-matter';
import logger from '../utils/logger.js';
// Import the combined file getter function and other necessary git functions
import { gitAdd, gitCommit, gitPush, getRepoInfo, getPublishableMarkdownFiles } from '../utils/gitHelper.js';
import { createArticle, updateArticle } from '../utils/devtoApi.js';
import type { DevToArticlePayload } from '../utils/devtoApi.js'; // Correct type import
import { readFileContent } from '../utils/fileHelper.js'; // Use readFileContent
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

  // 2. Get publishable files (Changed vs Remote OR New/ID-less local files)
  let publishableFiles;
  try {
    publishableFiles = await getPublishableMarkdownFiles(ARTICLES_DIR_NAME);
  } catch (error) {
    logger.error(`Failed to determine publishable files: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (publishableFiles.length === 0) {
    logger.info(`No changed or new (ID-less) Markdown files found in '${ARTICLES_DIR_NAME}'. Nothing to publish.`);
    return;
  }

  logger.info(`Found ${publishableFiles.length} Markdown file(s) to process:`);
  publishableFiles.forEach(f => logger.info(` - ${f}`));


  const results: PublishResult[] = [];
  const filesToGitAdd = new Set<string>(); // Store relative paths from repo root

  // 3. Process each publishable file
  for (const relativeFilePath of publishableFiles) { // relativeFilePath is from repo root, e.g., "articles/file.md"
    const absoluteFilePath = path.join(process.cwd(), relativeFilePath);
    logger.info(`Processing: ${relativeFilePath}`);
    try {
      // Read the current content from the local file
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
      let articleId: number | null | undefined = frontMatter.dev_to_article_id ? parseInt(String(frontMatter.dev_to_article_id), 10) : null;
      if (isNaN(articleId as number)) articleId = null;

      let frontMatterModifiedInScript = false;

      const payloadForApi: DevToArticlePayload = {
        article: {
          title: frontMatter.title as string,
          body_markdown: markdownForDevto,
          published: frontMatter.published === undefined ? false : frontMatter.published,
          tags: frontMatter.tags || [],
          series: frontMatter.series || null,
          main_image: frontMatter.main_image || null,
          canonical_url: frontMatter.canonical_url || null,
          description: frontMatter.description || '',
          organization_id: frontMatter.organization_id || null,
        }
      };

      if (articleId) {
        // Update existing article
        logger.info(`Updating article ID ${articleId} for ${relativeFilePath}...`);
        const updatedArticle = await updateArticle(articleId, payloadForApi);
        articleUrl = updatedArticle.url;
        logger.success(`Article updated on Dev.to: ${articleUrl}`);
        filesToGitAdd.add(relativeFilePath); // Add to git list as content was processed
      } else {
        // Create new article (because ID was missing)
        logger.info(`Publishing ${relativeFilePath} as a new article...`);
        const newArticleData = await createArticle(payloadForApi);
        articleId = newArticleData.id;
        articleUrl = newArticleData.url;

        // Add ID to front-matter of the original local file
        frontMatter.dev_to_article_id = articleId;
        const newLocalFileContent = matter.stringify(body_markdown, frontMatter);
        await fs.writeFile(absoluteFilePath, newLocalFileContent, 'utf8');
        frontMatterModifiedInScript = true;
        logger.info(`Article ID ${articleId} added to local file ${relativeFilePath}.`);
        logger.success(`New article published on Dev.to: ${articleUrl}`);
        filesToGitAdd.add(relativeFilePath); // Add because front-matter changed
      }
      results.push({ file: relativeFilePath, success: true, url: articleUrl, id: articleId as number });

    } catch (error) {
      logger.error(`Error processing file ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ file: relativeFilePath, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 4. Git operations only if there were files processed (even if API failed for some)
  //    and there are files staged for commit (filesToGitAdd).
  const filesToAddArray = Array.from(filesToGitAdd);
  if (filesToAddArray.length > 0) {
    try {
      logger.info('Adding, committing, and pushing changes to Git...');
      await gitAdd(filesToAddArray);
      const commitMessage = `Publish/update articles on Dev.to\n\nProcessed files:\n${results.filter(r => r.success).map(r => `- ${path.basename(r.file)} (ID: ${r.id}) -> ${r.url}`).join('\n')}`;
      // gitCommit handles "nothing to commit" case internally
      await gitCommit(commitMessage);
      // Only push if commit was successful (or if there was nothing to commit but we want to ensure remote is sync'd - depends on desired logic)
      // For simplicity, we push if the commit step didn't throw an error other than "nothing to commit"
      logger.info('Pushing changes...');
      await gitPush();
      logger.success('Commit and push to Git completed.');
    } catch (gitError) {
      logger.error('Error during Git operations:', gitError instanceof Error ? gitError.message : String(gitError));
      logger.warn('Publishing/updating to Dev.to might have completed, but recording to Git failed. Please check Git status and commit/push manually if needed.');
    }
  } else {
    logger.warn('No files required Git updates (either no publishable files found initially or API processing failed for all). Git operations skipped.');
  }

  // 5. Final summary report
  logger.info('\n--- Publishing Results Summary ---');
  results.forEach(r => {
    if (r.success) {
      logger.success(`[SUCCESS] ${r.file} -> ${r.url}`);
    } else if (!r.skipped) {
      logger.error(`[FAILED] ${r.file} - ${r.error}`);
    }
  });
  logger.info('---------------------------------');
}
