// src/utils/gitHelper.ts
import { execa, ExecaReturnValue, Options as ExecaOptions } from 'execa';
import logger from './logger.js';
import path from 'path'; // path is used by getLocalStatusChangedMarkdownFiles
// import fs from 'fs/promises'; // fs is not directly used in this version of gitHelper.ts

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
            // Ensure we only consider files directly in articlesDir, not from its subdirectories unless articlesDir itself is a path like 'content/articles'
            // The path from `git status --porcelain` can be relative to the repo root, or relative to CWD if git is run from a subdir.
            // Assuming this script is run from repo root, and articlesDir is like "articles".
            if (filePath.endsWith('.md')) {
                // filePath from 'git status --porcelain -- articlesDir' should be relative to articlesDir if it's inside,
                // or relative to repo root if articlesDir is '.'
                // For simplicity, we assume articlesDir is a top-level or specific sub-directory.
                // The current logic of `git status --porcelain -- ${articlesDir}` should mean paths are relative to CWD,
                // and if filePath starts with articlesDir, it's fine.
                // Let's refine to ensure the file is within the articlesDir scope.
                const fullPath = path.resolve(filePath); // Resolve to absolute path
                const targetFullPath = path.resolve(articlesDir);

                if (fullPath.startsWith(targetFullPath) && (status.startsWith('??') || status.includes('M') || status.startsWith('A') || status.startsWith('R'))) {
                    // We need the path relative to the repository root for consistency
                    const repoRoot = path.resolve((await runGitCommand(['rev-parse', '--show-toplevel'])).stdout.trim());
                    const relativePathToRepoRoot = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
                    statusFiles.push(relativePathToRepoRoot);
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

/**
 * Adds all changes in the working directory to the Git staging area.
 * Equivalent to `git add -A -v`.
 */
export async function gitAddAll(): Promise<void> {
    logger.info('Adding all changes to Git staging area (git add -A -v)...');
    await runGitCommand(['add', '-A', '-v']);
}

export async function gitCommit(message: string): Promise<void> {
    try {
        await runGitCommand(['commit', '-m', message]);
        logger.info('Changes committed to Git.');
    } catch (error: any) {
        if (error.stderr && error.stderr.includes('nothing to commit, working tree clean')) {
            logger.info('Git commit: Nothing to commit, working tree clean.');
            return; // Not an error in this context, just nothing to do.
        }
        // Log specific error from runGitCommand already handles full error object
        throw error; // Re-throw to be handled by the caller if needed
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
        logger.info('Push to Git attempted (generic).');
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
                 logger.info(`Push to Git completed (${remoteName}/${currentBranch}).`);
                 return;
             }
         } catch (upstreamError) {
             // If upstream isn't set or push fails, try pushing to origin/branchName
             logger.warn(`Upstream branch not set or push failed for '${currentBranch}'. Attempting to push to 'origin/${currentBranch}'.`);
             try {
                await runGitCommand(['push', 'origin', currentBranch]);
                logger.info(`Push to Git completed (origin/${currentBranch}).`);
                return;
             } catch (originPushError: any) {
                 // Check if the error is because the upstream is not set and suggest --set-upstream
                 if (originPushError.stderr && originPushError.stderr.includes('has no upstream branch')) {
                    logger.error(`Failed to push to 'origin/${currentBranch}'. The branch may not exist on the remote or an upstream branch is not set.`);
                    logger.info(`To push the current branch and set the remote as upstream, you can try: git push --set-upstream origin ${currentBranch}`);
                 } else {
                    logger.error(`Failed to push to 'origin/${currentBranch}'.`);
                 }
                 // Fallback to generic push might not be what user wants if specific push fails due to non-existent branch
                 // Consider re-throwing or providing more specific guidance
                 throw originPushError; // Re-throw the error
             }
         }
         // Fallback if parsing upstream failed unexpectedly
         logger.warn(`Could not determine specific upstream for '${currentBranch}'. Attempting push to 'origin/${currentBranch}' (fallback).`);
         await runGitCommand(['push', 'origin', currentBranch]);
         logger.info(`Push to Git completed (origin/${currentBranch} - fallback).`);

    } else {
        logger.warn(`Current Git branch name is '${currentBranch}'. Attempting generic push or push to default upstream.`);
        await runGitCommand(['push']);
        logger.info('Push to Git attempted (generic/default upstream).');
    }
}

export async function getRepoInfo(): Promise<RepoInfo> {
    try {
        const { stdout: remoteUrl } = await runGitCommand(['remote', 'get-url', 'origin']);
        const url = remoteUrl.trim();
        let user: string | null = null;
        let repo: string | null = null;

        // Try SSH format first: git@github.com:user/repo.git
        let match = url.match(/git@github\.com:([^\/]+)\/([^\.]+)(\.git)?/);
        if (match) {
            user = match[1];
            repo = match[2];
        } else {
            // Try HTTPS format: https://github.com/user/repo.git or https://github.com/user/repo
            match = url.match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+?)(\.git)?$/);
            if (match) {
                user = match[1];
                repo = match[2];
            }
        }

        if (!user || !repo) {
            logger.warn(`Could not parse user/repo from remote URL: ${url}. Will attempt to use GitHub Actions environment variables if available.`);
            // Fallback to GitHub Actions environment variables if available
            const githubRepository = process.env.GITHUB_REPOSITORY; // Format: owner/repository
            if (githubRepository) {
                const parts = githubRepository.split('/');
                if (parts.length === 2) {
                    user = parts[0];
                    repo = parts[1];
                    logger.info(`Using GITHUB_REPOSITORY: ${user}/${repo}`);
                }
            } else {
                 throw new Error(`Could not parse user/repo from remote URL: ${url} and GITHUB_REPOSITORY env var not set.`);
            }
        }


        const { stdout: branch } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
        let remoteBranchValue : string | null = null; // Renamed to avoid conflict with 'remoteBranch' in RepoInfo
         try {
             const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
             remoteBranchValue = upstream.trim();
         } catch {
             logger.debug('No upstream branch configured for current branch.');
             // Fallback for branch name if GITHUB_REF is available (e.g., in GitHub Actions)
             const githubRef = process.env.GITHUB_REF; // Format: refs/heads/branch_name or refs/tags/tag_name
             if (githubRef && githubRef.startsWith('refs/heads/')) {
                 const actionBranch = githubRef.substring('refs/heads/'.length);
                 if (branch.trim() === actionBranch) { // Ensure it's the same branch
                    logger.info(`Using GITHUB_REF for remote branch hint: origin/${actionBranch}`);
                    // This doesn't directly give remoteBranch, but implies origin/branch_name might be the target
                 }
             }
         }

        return { user, repo, branch: branch.trim(), remoteBranch: remoteBranchValue };
    } catch (error) {
        logger.error(`Failed to get repository info: ${error instanceof Error ? error.message : String(error)}`);
        return { user: null, repo: null, branch: null, remoteBranch: null }; // Return nulls to be checked by caller
    }
}