import path from 'path';
import matter from 'gray-matter';
import logger from '../utils/logger.js';
import { gitAdd, gitCommit, gitPush, getRepoInfo } from '../utils/gitHelper.js';
import { createArticle, updateArticle } from '../utils/devtoApi.js';
import { listMarkdownFiles, readFileContent, writeFileContent } from '../utils/fileHelper.js';
import { convertLocalPathsToGitHubUrls } from '../utils/imageHandler.js';

// Configuration: Default articles directory
const ARTICLES_DIR_NAME = 'articles';
const ARTICLES_DIR = path.join(process.cwd(), ARTICLES_DIR_NAME);

interface Result {
    file: string;
    success: boolean;
    url?: string;
    id?: number;
    error?: string;
}

export async function publishArticle(): Promise<void> {
    logger.info('Starting article publishing process...');

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

    let targetFiles;
    try {
        targetFiles = await listMarkdownFiles(ARTICLES_DIR);
    } catch (error) {
        logger.error(`Failed to read files from ${ARTICLES_DIR}: ${error instanceof Error ? error.message : String(error)}`);
        logger.info('Ensure the articles directory exists and contains Markdown files.');
        return;
    }

    if (targetFiles.length === 0) {
        logger.warn(`No Markdown files found in the '${ARTICLES_DIR_NAME}' directory to publish.`);
        return;
    }

    logger.info(`Found ${targetFiles.length} Markdown file(s) to potentially process in '${ARTICLES_DIR_NAME}'.`);

    const results: Result[] = [];
    const filesToGitAdd = new Set<string>(); // Use Set to avoid duplicates

    for (const fileName of targetFiles) {
        const absoluteFilePath = path.join(ARTICLES_DIR, fileName);
        const relativeFilePath = path.join(ARTICLES_DIR_NAME, fileName);
        logger.info(`Processing: ${relativeFilePath}`);
        try {
            const { data: frontMatter, content: body_markdown } = await readFileContent(absoluteFilePath);

            if (!frontMatter.title) {
                logger.warn(`Skipping ${relativeFilePath}: 'title' is missing in front-matter.`);
                results.push({ file: relativeFilePath, success: false, error: 'Missing title' });
                continue;
            }

            // Convert local image paths to GitHub URLs
            const markdownForDevto = await convertLocalPathsToGitHubUrls(
                body_markdown,
                relativeFilePath,
                repoInfo
            );

            let articleUrl: string | undefined;
            let articleId = frontMatter.dev_to_article_id;
            let frontMatterModified = false;

            const articlePayload = {
                article: {
                    title: frontMatter.title,
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
                logger.info(`Updating article ID ${articleId} for ${relativeFilePath}...`);
                const updatedArticle = await updateArticle(articleId, articlePayload);
                articleUrl = updatedArticle.url;
                logger.success(`Article updated: ${articleUrl}`);
                filesToGitAdd.add(relativeFilePath);
            } else {
                logger.info(`Publishing ${relativeFilePath} as a new article...`);
                const newArticleData = await createArticle(articlePayload);
                articleId = newArticleData.id;
                articleUrl = newArticleData.url;

                // Add ID to front-matter and save back to file
                frontMatter.dev_to_article_id = articleId;
                await writeFileContent(absoluteFilePath, frontMatter, body_markdown);
                frontMatterModified = true;
                logger.info(`Article ID ${articleId} added to local file ${relativeFilePath}.`);
                logger.success(`New article published: ${articleUrl}`);
                filesToGitAdd.add(relativeFilePath);
            }

            results.push({ 
                file: relativeFilePath, 
                success: true, 
                url: articleUrl, 
                id: articleId 
            });

        } catch (error) {
            logger.error(`Error processing file ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`);
            results.push({ 
                file: relativeFilePath, 
                success: false, 
                error: error instanceof Error ? error.message : String(error) 
            });
        }
    }

    const filesToAddArray = Array.from(filesToGitAdd);
    if (filesToAddArray.length > 0) {
        try {
            logger.info('Committing and pushing changes to Git...');
            await gitAdd(filesToAddArray);
            const commitMessage = `Publish/update articles on Dev.to\n\nProcessed files:\n${results
                .filter(r => r.success)
                .map(r => `- ${path.basename(r.file)} (ID: ${r.id}) -> ${r.url}`)
                .join('\n')}`;
            await gitCommit(commitMessage);
            await gitPush();
            logger.success('Commit and push to Git completed.');
        } catch (gitError) {
            logger.error('Error during Git operations:', gitError instanceof Error ? gitError.message : String(gitError));
            logger.warn('Publishing/updating to Dev.to might have completed, but recording to Git failed. Please check and commit manually.');
        }
    } else {
        logger.warn('No files were successfully processed for Dev.to or no local file changes required Git update, so Git operations were skipped.');
    }

    logger.info('\n--- Publishing Results ---');
    results.forEach(r => {
        if (r.success) {
            logger.success(`[SUCCESS] ${r.file} -> ${r.url}`);
        } else {
            logger.error(`[FAILED] ${r.file} - ${r.error}`);
        }
    });
    logger.info('------------------------');
}