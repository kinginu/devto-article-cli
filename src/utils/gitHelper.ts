// src/utils/gitHelper.ts
import { execa, ExecaReturnValue, Options as ExecaOptions } from 'execa'; // Import types
import logger from './logger.js';
import path from 'path';

// Define interfaces for clarity
interface GitResponse {
    stdout: string;
    stderr: string;
    exitCode: number;
}

interface RepoInfo {
    user: string | null;
    repo: string | null;
    branch: string | null;
    remoteBranch?: string | null; // Add remote tracking branch
}

// Helper function to run Git commands
async function runGitCommand(args: string[], options: ExecaOptions = {}): Promise<GitResponse> {
    try {
        const result: ExecaReturnValue<string> = await execa('git', args, options);
        const { stdout = '', stderr = '', exitCode = 0 } = result;

        // --- Adjusted stderr warning logic ---
        const isPushCommand = args[0] === 'push';
        const isCommitCommand = args[0] === 'commit';
        const knownNonErrors = [
            'nothing to commit, working tree clean',
            'On branch',
            'Your branch is up to date',
            'Your branch is ahead of',
            'To ' // Common start for successful push messages
        ];

        // Log as warning only if stderr has content AND it's not a known non-error message
        // AND it's not a push command (where 'To ' messages are expected on success)
        if (exitCode === 0 && stderr && !knownNonErrors.some(msg => stderr.includes(msg))) {
             // For push, only warn if stderr contains something unexpected *other than* the 'To ...' message
             if (isPushCommand && !stderr.startsWith('To ')) {
                 logger.warn(`Git push STDERR (but successful): ${stderr.trim()}`);
             } else if (!isPushCommand) {
                 logger.warn(`Git command STDERR (but successful): ${stderr.trim()}`);
             }
        }
        // ---------------------------------------

        return { stdout, stderr, exitCode };
    } catch (error: any) {
        logger.error(`Git command execution error (git ${args.join(' ')}): ${error.shortMessage || error.message}`);
        if (error.stderr) logger.error(`Git STDERR: ${error.stderr}`);
        if (error.stdout) logger.info(`Git STDOUT: ${error.stdout}`);
        throw error;
    }
}

// --- New function to get changed markdown files against remote ---
export async function getChangedMarkdownFilesAgainstRemote(articlesDir: string = 'articles'): Promise<string[]> {
    try {
        logger.info('Fetching latest changes from remote repository...');
        await runGitCommand(['fetch']); // Fetch latest state from remote

        // Determine the remote tracking branch for the current branch
        let remoteBranch = '';
        try {
            const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
            remoteBranch = upstream.trim();
            logger.debug(`Comparing against remote branch: ${remoteBranch}`);
        } catch (upstreamError: any) {
            // Handle case where upstream is not set
            logger.warn('Upstream branch not set for the current branch. Comparing against default remote branch (e.g., origin/main or origin/master).');
            // Attempt common defaults - this might need refinement based on repo setup
            try {
                await runGitCommand(['rev-parse', '--verify', 'origin/main']);
                remoteBranch = 'origin/main';
            } catch {
                try {
                    await runGitCommand(['rev-parse', '--verify', 'origin/master']);
                    remoteBranch = 'origin/master';
                } catch {
                     logger.error('Could not determine a remote branch to compare against. Cannot detect changes.');
                     throw new Error('Remote tracking branch not found.');
                }
            }
             logger.debug(`Falling back to compare against: ${remoteBranch}`);
        }


        logger.info(`Checking for changed files in '${articlesDir}' compared to '${remoteBranch}'...`);
        // Get list of changed files (Added, Modified, Renamed) in the articles directory compared to the remote branch
        const { stdout } = await runGitCommand(['diff', '--name-only', '--diff-filter=AMR', remoteBranch, 'HEAD', '--', articlesDir]);
        const changedFiles = stdout.split('\n').filter(file => file.trim() !== '' && file.endsWith('.md'));

        logger.debug('Changed files found:', changedFiles);
        return changedFiles; // Returns paths relative to repo root

    } catch (error) {
        logger.error('Failed to get changed Markdown files against remote.');
        throw error;
    }
}
// -----------------------------------------------------------------

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
        // Determine remote tracking branch to push to the correct upstream
        let remoteBranch = '';
         try {
            const { stdout: upstream } = await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
            // Upstream format is usually 'origin/branchname', we need 'origin branchname' for push
             const remoteParts = upstream.trim().split('/');
             if(remoteParts.length >= 2) {
                const remoteName = remoteParts[0];
                // const remoteBranchName = remoteParts.slice(1).join('/'); // Handles branches with slashes
                 await runGitCommand(['push', remoteName, currentBranch]);
                 return;
             }
         } catch (upstreamError) {
             logger.warn(`Upstream branch not set for '${currentBranch}'. Pushing to 'origin/${currentBranch}'.`);
             // Fallback if upstream isn't set explicitly
             await runGitCommand(['push', 'origin', currentBranch]);
             return;
         }
         // Fallback if parsing upstream failed unexpectedly
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
