import inquirer from 'inquirer';
import { format } from 'date-fns';
import path from 'path';
import fs from 'fs/promises';
import matter from 'gray-matter';
import logger from '../utils/logger.js';
import { sanitizeSlug } from '../utils/fileHelper.js';

// Configuration: Default articles directory
const ARTICLES_DIR_NAME = 'articles';
const ARTICLES_DIR = path.join(process.cwd(), ARTICLES_DIR_NAME);

export async function newArticle(): Promise<void> {
    logger.info('Creating a new article...');

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'title',
            message: 'Enter the title of the article:',
            validate: function (value) {
                if (value.length) {
                    return true;
                }
                return 'Title is required.';
            },
        },
        {
            type: 'input',
            name: 'slug',
            message: 'Enter the slug for the filename (e.g., my-awesome-post):',
            validate: function (value) {
                if (value.length) {
                    return true;
                }
                return 'Slug is required.';
            },
        },
    ]);

    const sanitizedSlug = sanitizeSlug(answers.slug);
    const timestamp = format(new Date(), 'yyyy-MM-dd-HH-mm-ss');
    const fileName = `${timestamp}-${sanitizedSlug}.md`;
    const filePath = path.join(ARTICLES_DIR, fileName);

    const frontMatter = {
        title: answers.title,
        published: false, // Default to draft
        tags: [],
        // dev_to_article_id: null, // ID will be added upon publishing
    };

    const fileContent = matter.stringify('', frontMatter); // Start with an empty body

    try {
        await fs.mkdir(ARTICLES_DIR, { recursive: true });
        await fs.writeFile(filePath, fileContent);
        logger.success(`Article file created: ${filePath}`);
        logger.info('Please write your article content in the file.');
    } catch (error) {
        logger.error('Failed to create article file:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}