// src/utils/gitHelper.ts
import { execa, ExecaReturnValue, Options as ExecaOptions } from 'execa';
import logger from './logger.js';
import path from 'path';
import fs from 'fs/promises';
import { readFileContent } from './fileHelper.js'; // Use existing helper

// --- Interfaces ---
interface GitResponse {
    stdout: string;
    stderr: string;
    exitCode: number;
}

interface RepoInfo {
    user: string | null;
    repo: string | null;
    branch: string | null;
    remoteBranch?: string | null;
}

// --- Helper to run Git commands ---
async function runGitCommand(args: string[], options: ExecaOptions = {}): Promise<GitResponse> {
    try {
        const result: ExecaReturnValue<string> = await execa('git', args, options);
        const { stdout = '', stderr = '', exitCode = 0 } = result;

        const isPushCommand = args[0] === 'push';
        const knownNonErrors = [
            'nothing to commit, working tree clean',
            'On branch',
            'Your branch is up to date',
            'Your branch is ahead of',
            'To '
        ];

        if (exitCode === 0 && stderr && !knownNonErrors.some(msg => stderr.includes(msg))) {
             if (isPushCommand && !stderr.startsWith('To ')) {
                 logger.warn(`Git push STDERR (but successful): ${stderr.trim()}`);
             } else if (!isPushCommand) {
                 logger.warn(`Git command STDERR (but successful): ${stderr.trim()}`);
             }
        }

        return { stdout, stderr, exitCode };
    } catch (error: any) {
        logger.error(`Git command execution error (git ${args.join(' ')}): ${error.shortMessage || error.message}`);
        if (error.stderr) logger.error(`Git STDERR: ${error.stderr}`);
        if (error.stdout) logger.info(`Git STDOUT: ${error.stdout}`);
        throw error;
    }
}

// --- Condition A: Function to get changed files against remote ---
async function getChangedFilesAgainstRemote(articlesDir: string): Promise<string[]> {
    let remoteBranch = '';
    try {
        logger.info('Fetching latest changes from remote repository...');
        await runGitCommand(['fetch', 'origin']);

        try {
            const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
            remoteBranch = upstream.trim();
            logger.debug(`Comparing against remote branch: ${remoteBranch}`);
        } catch (upstreamError: any) {
            logger.warn('Upstream branch not set or found. Comparing against default remote branches (origin/main, origin/master).');
            try { await runGitCommand(['rev-parse', '--verify', 'origin/main']); remoteBranch = 'origin/main'; }
            catch {
                try { await runGitCommand(['rev-parse', '--verify', 'origin/master']); remoteBranch = 'origin/master'; }
                catch { throw new Error('Remote tracking branch (origin/main or origin/master) not found.'); }
            }
             logger.debug(`Falling back to compare against: ${remoteBranch}`);
        }

        logger.info(`Checking for committed changes in '${articlesDir}' compared to '${remoteBranch}'...`);
        const { stdout } = await runGitCommand(['diff', '--name-only', '--diff-filter=AMR', remoteBranch, 'HEAD', '--', articlesDir]);
        const changedFiles = stdout.split('\n').filter(file => file.trim() !== '' && file.endsWith('.md'));
        logger.debug('Files changed compared to remote:', changedFiles);
        return changedFiles; // Returns paths relative to repo root

    } catch (error) {
        logger.error(`Failed to get changed files against remote: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

// --- Condition B: Function to get local markdown files without dev_to_article_id ---
async function getLocalNewMarkdownFiles(articlesDir: string): Promise<string[]> {
    const localNewFiles: string[] = [];
    const articlesDirPath = path.join(process.cwd(), articlesDir);
    logger.info(`Scanning local directory '${articlesDir}' for new files (no Dev.to ID)...`);
    try {
        const dirents = await fs.readdir(articlesDirPath, { withFileTypes: true });
        for (const dirent of dirents) {
            if (dirent.isFile() && dirent.name.endsWith('.md')) {
                const filePath = path.join(articlesDirPath, dirent.name);
                const relativeFilePath = path.join(articlesDir, dirent.name).replace(/\\/g, '/');
                try {
                    const { data: frontMatter } = await readFileContent(filePath);
                    if (!frontMatter.dev_to_article_id) {
                        localNewFiles.push(relativeFilePath);
                    }
                } catch (fileReadError) {
                    logger.warn(`Could not read or parse frontmatter for ${relativeFilePath}. Skipping ID check.`);
                }
            }
        }
        logger.debug('Local files without dev_to_article_id:', localNewFiles);
        return localNewFiles;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            logger.warn(`Directory not found when checking for new files: ${articlesDirPath}`);
            return [];
        }
        logger.error(`Error listing or checking local markdown files: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

// --- Condition C: Function using 'git status' to find locally changed/new files ---
async function getLocalStatusChangedMarkdownFiles(articlesDir: string): Promise<string[]> {
    try {
        logger.info(`Checking Git status for locally changed/new Markdown files in '${articlesDir}'...`);
        const { stdout } = await runGitCommand(['status', '--porcelain', '--untracked-files=normal', '--', articlesDir]);
        const statusFiles: string[] = [];
        const lines = stdout.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
            const status = line.substring(0, 2);
            const filePathRaw = line.substring(3).trim();
            // Handle potential quotes around filenames if they contain spaces
            const filePath = filePathRaw.startsWith('"') && filePathRaw.endsWith('"')
                           ? filePathRaw.substring(1, filePathRaw.length - 1)
                           : filePathRaw;

            // We are interested in Untracked (??), Modified ( M, M ), Added (A ), Renamed (R ) within the articlesDir
            // Note: Renamed files might need special handling later if needed.
            if (filePath.endsWith('.md') && (status.startsWith('??') || status.includes('M') || status.startsWith('A') || status.startsWith('R'))) {
                 // Ensure the path is relative to the repo root and uses forward slashes
                 const relativePath = path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, '/');
                 // Double-check it's within the target directory (git status might sometimes include parent dirs if pathspec is ambiguous)
                 if(relativePath.startsWith(articlesDir.replace(/\\/g, '/') + '/')) {
                    statusFiles.push(relativePath);
                 } else {
                     logger.debug(`Ignoring file outside target directory: ${relativePath}`);
                 }
            }
        }
        logger.debug('Files with local Git status changes (Untracked/Modified/Added/Renamed):', statusFiles);
        return statusFiles;
    } catch (error) {
        logger.error('Failed to get locally changed/new Markdown files via git status.');
        throw error;
    }
}


// --- Function combining all checks (A + B + C) ---
export async function getPublishableMarkdownFiles(articlesDir: string = 'articles'): Promise<string[]> {
    logger.info('Determining files to publish based on remote changes, local ID status, and local Git status...');
    try {
        // Run checks concurrently for efficiency
        const [changedVsRemote, localNewFiles, localStatusChanged] = await Promise.all([
            getChangedFilesAgainstRemote(articlesDir).catch(e => { logger.warn('Could not get remote diff, proceeding without it.'); return []; }), // Condition A
            getLocalNewMarkdownFiles(articlesDir).catch(e => { logger.warn('Could not check local files for IDs, proceeding without it.'); return []; }),     // Condition B
            getLocalStatusChangedMarkdownFiles(articlesDir).catch(e => { logger.warn('Could not get local git status, proceeding without it.'); return []; }) // Condition C
        ]);

        // Combine and deduplicate using a Set
        const combinedSet = new Set([...changedVsRemote, ...localNewFiles, ...localStatusChanged]);
        const publishableFiles = Array.from(combinedSet);

        logger.info(`Final list of files to process: ${publishableFiles.length > 0 ? publishableFiles.join(', ') : 'None'}`);
        return publishableFiles;
    } catch (error) {
         logger.error(`Failed to determine publishable files: ${error instanceof Error ? error.message : String(error)}`);
         throw error; // Re-throw error to stop the publish process
    }
}

// --- Standard Git operations ---
export async function gitAdd(files: string[]): Promise<void> {
    if (!Array.isArray(files) || files.length === 0) {
        logger.warn('Git add: No files to add.');
        return;
    }
    await runGitCommand(['add', ...files]);
}

export async function gitCommit(message: string): Promise<void> {
    try {
        await runGitCommand(['commit', '-m', message]);
    } catch (error: any) {
        if (error.stderr && error.stderr.includes('nothing to commit, working tree clean')) {
            logger.info('Git commit: Nothing to commit, working tree clean.');
            return;
        }
        throw error;
    }
}

export async function gitPush(): Promise<void> {
    let currentBranch = '';
    try {
        const { stdout } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
        currentBranch = stdout.trim();
    } catch (error) {
        logger.warn('Could not determine current Git branch. Attempting generic push.');
        await runGitCommand(['push']);
        return;
    }

    if (currentBranch && currentBranch !== 'HEAD') {
        let remoteBranch = '';
         try {
            const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
             const remoteParts = upstream.trim().split('/');
             if(remoteParts.length >= 2) {
                const remoteName = remoteParts[0];
                 await runGitCommand(['push', remoteName, currentBranch]);
                 return;
             }
         } catch (upstreamError) {
             logger.warn(`Upstream branch not set for '${currentBranch}'. Pushing to 'origin/${currentBranch}'.`);
             await runGitCommand(['push', 'origin', currentBranch]);
             return;
         }
         logger.warn(`Could not determine specific upstream for '${currentBranch}'. Pushing to 'origin/${currentBranch}'.`);
         await runGitCommand(['push', 'origin', currentBranch]);

    } else {
        logger.warn(`Current Git branch name is '${currentBranch}'. Attempting generic push or push to default upstream.`);
        await runGitCommand(['push']);
    }
}

export async function getRepoInfo(): Promise<RepoInfo> {
    try {
        const { stdout: remoteUrl } = await runGitCommand(['remote', 'get-url', 'origin']);
        const url = remoteUrl.trim();
        let user: string | null = null;
        let repo: string | null = null;

        let match = url.match(/git@github\.com:([^\/]+)\/([^\.]+)\.git/);
        if (match) {
            user = match[1];
            repo = match[2];
        } else {
            match = url.match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)(\.git)?/);
            if (match) {
                user = match[1];
                repo = match[2];
            }
        }

        if (!user || !repo) {
            throw new Error(`Could not parse user/repo from remote URL: ${url}`);
        }

        const { stdout: branch } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
        let remoteBranch : string | null = null;
         try {
             const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
             remoteBranch = upstream.trim();
         } catch {
             logger.debug('No upstream branch configured for current branch.');
         }

        return { user, repo, branch: branch.trim(), remoteBranch };
    } catch (error) {
        logger.error(`Failed to get repository info: ${error instanceof Error ? error.message : String(error)}`);
        return { user: null, repo: null, branch: null, remoteBranch: null };
    }
}
