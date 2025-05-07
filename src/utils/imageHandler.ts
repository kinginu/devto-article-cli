import path from 'path';
import logger from './logger.js';

interface RepoInfo {
    user: string | null;
    repo: string | null;
    branch: string | null;
}

// Basic regex to find Markdown image tags: ![alt text](path)
// Captures the alt text and the path. Handles relative paths starting with ./ or ../ or just the dir name
const IMAGE_REGEX = /!\[(.*?)\]\((?!https?:\/\/)(.*?)\)/g;

export async function convertLocalPathsToGitHubUrls(
    markdownContent: string,
    markdownFilePath: string,
    repoInfo: RepoInfo
): Promise<string> {
    const { user, repo, branch } = repoInfo;
    if (!user || !repo || !branch) {
        logger.warn('Cannot convert image paths: Missing repository info (user, repo, or branch).');
        return markdownContent; // Return original content if repo info is missing
    }

    const markdownDir = path.dirname(markdownFilePath); // Directory of the markdown file (e.g., 'articles')

    const convertedMarkdown = markdownContent.replace(IMAGE_REGEX, (match, altText, localPath) => {
        try {
            // Construct the path relative to the repository root
            const imagePathFromRepoRoot = path.join(markdownDir, localPath).replace(/\\/g, '/');

            // Construct the GitHub Raw URL
            const githubUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${imagePathFromRepoRoot}`;

            logger.debug(`Converted image path: "${localPath}" to "${githubUrl}"`);
            return `![${altText}](${githubUrl})`;

        } catch (error) {
            logger.warn(`Could not resolve or convert image path "${localPath}" found in ${markdownFilePath}: ${error instanceof Error ? error.message : String(error)}`);
            return match; // Return the original match if conversion fails
        }
    });

    return convertedMarkdown;
}