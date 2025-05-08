// src/utils/gitHelper.ts
import { execa, ExecaReturnValue, Options as ExecaOptions } from 'execa';
import logger from './logger.js';
import path from 'path';
import fs from 'fs/promises';
// readFileContent is still needed by checkConsistency, so keep it if check command exists
// import { readFileContent } from './fileHelper.js'; // Not needed directly in this file anymore

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
        // Ensure GIT_TERMINAL_PROMPT is set to 0 to prevent prompts for credentials etc.
        const gitOptions = { ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
        const result: ExecaReturnValue<string> = await execa('git', args, gitOptions);
        const { stdout = '', stderr = '', exitCode = 0 } = result;

        // Adjusted stderr warning logic
        const isPushCommand = args[0] === 'push';
        const knownNonErrors = [
            'nothing to commit, working tree clean',
            'On branch',
            'Your branch is up to date',
            'Your branch is ahead of',
            'To ' // Common start for successful push messages
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
        if (error.stdout) logger.info(`Git STDOUT: ${error.stdout}`); // stdout might still be useful for context
        throw error; // Re-throw the error for the calling function to handle
    }
}

// --- Condition A: Function to get changed files against remote ---
async function getChangedFilesAgainstRemote(articlesDir: string): Promise<string[]> {
    let remoteBranch = '';
    try {
        logger.info('Fetching latest changes from remote repository...');
        await runGitCommand(['fetch', 'origin']); // Fetch from origin explicitly

        // Determine remote tracking branch
        try {
            // Try to get the upstream branch configured for the current local branch
            const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
            remoteBranch = upstream.trim();
            logger.debug(`Comparing against configured remote branch: ${remoteBranch}`);
        } catch (upstreamError: any) {
            // If upstream isn't set, try common defaults
            logger.warn('Upstream branch not set or found. Comparing against default remote branches (origin/main, origin/master).');
            try {
                await runGitCommand(['rev-parse', '--verify', 'origin/main']);
                remoteBranch = 'origin/main';
            } catch {
                try {
                    await runGitCommand(['rev-parse', '--verify', 'origin/master']);
                    remoteBranch = 'origin/master';
                } catch {
                     logger.error('Could not determine a remote branch (origin/main or origin/master) to compare against.');
                     throw new Error('Remote tracking branch not found.');
                }
            }
             logger.debug(`Falling back to compare against: ${remoteBranch}`);
        }

        logger.info(`Checking for committed changes in '${articlesDir}' compared to '${remoteBranch}'...`);
        // Get list of changed files (Added, Modified, Renamed) compared to the remote branch
        // Use '...' to compare the tip of the remote branch with the local HEAD
        const { stdout } = await runGitCommand(['diff', '--name-only', '--diff-filter=AMR', `${remoteBranch}...HEAD`, '--', articlesDir]);
        const changedFiles = stdout.split('\n').filter(file => file.trim() !== '' && file.endsWith('.md'));
        logger.debug('Files changed compared to remote:', changedFiles);
        return changedFiles; // Returns paths relative to repo root

    } catch (error) {
        logger.error(`Failed to get changed files against remote: ${error instanceof Error ? error.message : String(error)}`);
        throw error; // Propagate the error
    }
}

// --- Condition C: Function using 'git status' to find locally changed/new files ---
async function getLocalStatusChangedMarkdownFiles(articlesDir: string): Promise<string[]> {
    try {
        logger.info(`Checking Git status for locally changed/new Markdown files in '${articlesDir}'...`);
        // Use --porcelain v1 for script-friendly output
        // Limit the status check to the specified directory
        const { stdout } = await runGitCommand(['status', '--porcelain', '--untracked-files=normal', '--', articlesDir]);
        const statusFiles: string[] = [];
        const lines = stdout.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
            const status = line.substring(0, 2);
            let filePathRaw = line.substring(3).trim();

            // Handle renamed files (R XX ORIG_PATH -> NEW_PATH)
            if (status.startsWith('R')) {
                const paths = filePathRaw.split(' -> ');
                if (paths.length === 2) {
                    filePathRaw = paths[1]; // Use the new path
                } else {
                    logger.warn(`Could not parse renamed file path: ${filePathRaw}`);
                    continue;
                }
            }

            // Handle potential quotes around filenames if they contain spaces
            const filePath = filePathRaw.startsWith('"') && filePathRaw.endsWith('"')
                           ? filePathRaw.substring(1, filePathRaw.length - 1)
                           : filePathRaw;

            // We are interested in Untracked (??), Modified ( M, M ), Added (A ), Renamed (R ) within the articlesDir
            if (filePath.endsWith('.md') && (status.startsWith('??') || status.includes('M') || status.startsWith('A') || status.startsWith('R'))) {
                 // Construct path relative to repo root, assuming articlesDir is relative to root
                 const relativePath = path.join(articlesDir, path.basename(filePath)).replace(/\\/g, '/');
                 // Double-check it's within the target directory by comparing normalized paths
                 const targetDirNormalized = path.normalize(articlesDir).replace(/\\/g, '/');
                 const fileDirNormalized = path.dirname(relativePath).replace(/\\/g, '/');

                 if(fileDirNormalized === targetDirNormalized) {
                    statusFiles.push(relativePath);
                 } else {
                     // This case might happen if git status includes files from subdirs not directly specified
                     // or if path manipulation is complex. Log for debugging.
                     logger.debug(`Ignoring file potentially outside target directory: ${relativePath} (Target: ${targetDirNormalized}, FileDir: ${fileDirNormalized})`);
                 }
            }
        }
        logger.debug('Files with local Git status changes (Untracked/Modified/Added/Renamed):', statusFiles);
        return statusFiles;
    } catch (error) {
        logger.error(`Failed to get locally changed/new Markdown files via git status: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}


// --- Function combining checks A + C ---
export async function getPublishableMarkdownFiles(articlesDir: string = 'articles'): Promise<string[]> {
    logger.info('Determining files to publish based on remote changes and local Git status...');
    try {
        // Run checks concurrently for efficiency
        const [changedVsRemote, localStatusChanged] = await Promise.all([
            getChangedFilesAgainstRemote(articlesDir).catch(e => { logger.warn(`Could not get remote diff: ${e.message}`); return []; }), // Condition A
            getLocalStatusChangedMarkdownFiles(articlesDir).catch(e => { logger.warn(`Could not get local git status: ${e.message}`); return []; }) // Condition C
        ]);

        // Combine and deduplicate using a Set
        const combinedSet = new Set([...changedVsRemote, ...localStatusChanged]);
        const publishableFiles = Array.from(combinedSet);

        logger.info(`Final list of files to process based on A+C: ${publishableFiles.length > 0 ? publishableFiles.join(', ') : 'None'}`);
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
            // Try pushing to the configured upstream first
            const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
             const remoteParts = upstream.trim().split('/');
             if(remoteParts.length >= 2) {
                const remoteName = remoteParts[0];
                 await runGitCommand(['push', remoteName, currentBranch]);
                 return;
             }
         } catch (upstreamError) {
             // If upstream isn't set or push fails, try pushing to origin/branchName
             logger.warn(`Upstream branch not set or push failed for '${currentBranch}'. Pushing to 'origin/${currentBranch}'.`);
             try {
                await runGitCommand(['push', 'origin', currentBranch]);
                return;
             } catch (originPushError) {
                 logger.error(`Failed to push to 'origin/${currentBranch}'. Attempting generic push.`);
                 // Fallback to generic push if specific push fails
                 await runGitCommand(['push']);
                 return;
             }
         }
         // Fallback if parsing upstream failed unexpectedly
         logger.warn(`Could not determine specific upstream for '${currentBranch}'. Attempting push to 'origin/${currentBranch}'.`);
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
