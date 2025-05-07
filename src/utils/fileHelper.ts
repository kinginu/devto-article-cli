import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import logger from './logger.js';

interface FileContent {
    data: Record<string, any>;
    content: string;
}

export async function readFileContent(filePath: string): Promise<FileContent> {
    const content = await fs.readFile(filePath, 'utf8');
    return matter(content);
}

export async function writeFileContent(filePath: string, frontMatter: Record<string, any>, markdownBody: string): Promise<void> {
    const newFileContent = matter.stringify(markdownBody, frontMatter);
    await fs.writeFile(filePath, newFileContent, 'utf8');
}

export function sanitizeSlug(slug: string): string {
    if (!slug) return '';
    return slug
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');
}

export async function listMarkdownFiles(directoryPath: string): Promise<string[]> {
    try {
        const dirents = await fs.readdir(directoryPath, { withFileTypes: true });
        return dirents
            .filter(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
            .map(dirent => dirent.name);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            logger.warn(`Directory not found: ${directoryPath}`);
            return [];
        }
        logger.error(`Error listing markdown files in ${directoryPath}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}