import path from 'path';
import logger from '../utils/logger.js';
import { getArticleById, getMyPublishedArticles } from '../utils/devtoApi.js';
import { listMarkdownFiles, readFileContent } from '../utils/fileHelper.js';

// Configuration: Default articles directory
const ARTICLES_DIR_NAME = 'articles';
const ARTICLES_DIR = path.join(process.cwd(), ARTICLES_DIR_NAME);

export async function checkConsistency(): Promise<void> {
    logger.info('Starting consistency check between local articles and Dev.to...');

    let localArticleFiles;
    try {
        localArticleFiles = await listMarkdownFiles(ARTICLES_DIR);
    } catch (error) {
        logger.error(`Failed to list local articles: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    const localArticlesMap = new Map<number, { title: string; localPath: string; fileName: string }>();
    const localFilesWithoutId: string[] = [];
    let localFilesWithIdCount = 0;

    logger.info('\n--- Phase 1: Checking Local Articles against Dev.to ---');
    if (localArticleFiles.length === 0) {
        logger.info(`No local Markdown files found in '${ARTICLES_DIR_NAME}'.`);
    }

    for (const fileName of localArticleFiles) {
        const filePath = path.join(ARTICLES_DIR, fileName);
        const relativeFilePath = path.join(ARTICLES_DIR_NAME, fileName);
        try {
            const { data: frontMatter } = await readFileContent(filePath);
            if (frontMatter.dev_to_article_id) {
                const localId = parseInt(frontMatter.dev_to_article_id, 10);
                if (isNaN(localId)) {
                    logger.warn(`[INVALID ID] ${relativeFilePath}: Contains non-numeric dev_to_article_id "${frontMatter.dev_to_article_id}". Skipping Dev.to check for this file.`);
                    continue;
                }
                localArticlesMap.set(localId, { 
                    title: frontMatter.title,
                    localPath: relativeFilePath,
                    fileName
                });
                localFilesWithIdCount++;
                try {
                    const devtoArticle = await getArticleById(localId);
                    if (devtoArticle) {
                        if (devtoArticle.title !== frontMatter.title) {
                            logger.warn(`[TITLE MISMATCH] ${relativeFilePath} (ID: ${localId}): Local title "${frontMatter.title}" vs Dev.to title "${devtoArticle.title}".`);
                        } else {
                            logger.info(`[OK] ${relativeFilePath} (ID: ${localId}): Exists on Dev.to and title matches.`);
                        }
                    }
                } catch (apiError: any) {
                    if (apiError.response?.status === 404) {
                        logger.error(`[NOT FOUND ON DEV.TO] ${relativeFilePath}: Local article with ID ${localId} not found on Dev.to.`);
                    } else {
                        logger.error(`[API ERROR] ${relativeFilePath} (ID: ${localId}): Could not verify on Dev.to.`);
                    }
                }
            } else {
                localFilesWithoutId.push(relativeFilePath);
            }
        } catch (fileError) {
            logger.error(`[FILE ERROR] Could not read or parse ${relativeFilePath}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
        }
    }

    if (localFilesWithoutId.length > 0) {
        logger.info(`\n--- Found ${localFilesWithoutId.length} Local Article(s) Not Yet Published (No Dev.to ID) ---`);
        localFilesWithoutId.forEach(filePath => logger.info(`  - ${filePath}`));
    }
    if (localFilesWithIdCount === 0 && localFilesWithoutId.length === 0 && localArticleFiles.length > 0) {
        logger.info('All local articles processed seem to be without Dev.to IDs.');
    }

    logger.info('\n--- Phase 2: Checking Dev.to Articles against Local Files ---');
    try {
        const devtoArticles = await getMyPublishedArticles();
        if (!devtoArticles || devtoArticles.length === 0) {
            logger.info('No published articles found on Dev.to for your account to check against local files.');
        } else {
            logger.info(`Found ${devtoArticles.length} published article(s) on Dev.to. Checking for local counterparts...`);
            let missingLocallyCount = 0;
            for (const devtoArticle of devtoArticles) {
                if (!localArticlesMap.has(devtoArticle.id)) {
                    logger.warn(`[NOT FOUND LOCALLY] Dev.to Article: "${devtoArticle.title}" (ID: ${devtoArticle.id}, URL: ${devtoArticle.url}) does not have a corresponding local file linked with this ID.`);
                    missingLocallyCount++;
                }
            }
            if (missingLocallyCount === 0 && devtoArticles.length > 0) {
                logger.info('All published Dev.to articles appear to have corresponding local files (based on ID).');
            }
        }
    } catch (apiError) {
        logger.error(`[API ERROR] Could not fetch your published articles from Dev.to for phase 2 check.`);
    }

    logger.info('\nConsistency check finished.');
}