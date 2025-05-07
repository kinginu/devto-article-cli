// src/utils/gitHelper.ts
import { execa, ExecaReturnValue } from 'execa'; // Import ExecaReturnValue type
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
}

// Helper function to run Git commands
async function runGitCommand(args: string[], options: Record<string, any> = {}): Promise<GitResponse> {
    try {
        // Execute the git command using execa
        const result: ExecaReturnValue<string> = await execa('git', args, options);
        // Destructure results, providing defaults for safety
        const { stdout = '', stderr = '', exitCode = 0 } = result;

        // Check for potential warnings in stderr, only if the command succeeded (exitCode 0)
        // Exclude known non-error messages from stderr
        const isPushCommand = args[0] === 'push';
        const knownNonErrors = [
            'nothing to commit, working tree clean',
            'On branch', // Common status message start
            'To ' // Common start for successful push messages
        ];

        // Log as warning only if stderr has content AND it's not a known non-error message
        // OR if it's a push command (where 'To ' messages are expected on success)
        if (exitCode === 0 && stderr && !knownNonErrors.some(msg => stderr.includes(msg)) && !isPushCommand) {
             logger.warn(`Git command STDERR (but successful): ${stderr.trim()}`);
        } else if (exitCode === 0 && stderr && isPushCommand && !stderr.startsWith('To ')) {
             // For push, only warn if stderr contains something unexpected *other than* the 'To ...' message
             logger.warn(`Git push STDERR (but successful): ${stderr.trim()}`);
        }


        return { stdout, stderr, exitCode };
    } catch (error: any) {
        // Handle errors thrown by execa (e.g., non-zero exit code)
        logger.error(`Git command execution error (git ${args.join(' ')}): ${error.shortMessage || error.message}`);
        if (error.stderr) logger.error(`Git STDERR: ${error.stderr}`);
        if (error.stdout) logger.info(`Git STDOUT: ${error.stdout}`); // stdout might still be useful for context
        throw error; // Re-throw the error for the calling function to handle
    }
}

// Exported function to add files to staging
export async function gitAdd(files: string[]): Promise<void> {
    if (!Array.isArray(files) || files.length === 0) {
        logger.warn('Git add: No files to add.');
        return;
    }
    // Run 'git add' with the provided file paths
    await runGitCommand(['add', ...files]);
}

// Exported function to commit changes
export async function gitCommit(message: string): Promise<void> {
    try {
        // Run 'git commit' with the provided message
        await runGitCommand(['commit', '-m', message]);
    } catch (error: any) {
        // Specifically handle the "nothing to commit" case, which is not a failure
        if (error.stderr && error.stderr.includes('nothing to commit, working tree clean')) {
            logger.info('Git commit: Nothing to commit, working tree clean.');
            return; // Do not treat as an error
        }
        // Re-throw other errors
        throw error;
    }
}

// Exported function to push changes to the remote repository
export async function gitPush(): Promise<void> {
    let currentBranch = '';
    try {
        // Get the current branch name
        const { stdout } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
        currentBranch = stdout.trim();
    } catch (error) {
        // If branch detection fails, attempt a generic push
        logger.warn('Could not determine current Git branch. Attempting generic push.');
        await runGitCommand(['push']);
        return;
    }

    // Push to the specific branch on the 'origin' remote if the branch name is valid
    if (currentBranch && currentBranch !== 'HEAD') {
        await runGitCommand(['push', 'origin', currentBranch]);
    } else {
        // Fallback to generic push if branch name is unusual ('HEAD' or empty)
        logger.warn(`Current Git branch name is '${currentBranch}'. Attempting generic push or push to default upstream.`);
        await runGitCommand(['push']);
    }
}

// Exported function to get repository information (user, repo, branch)
export async function getRepoInfo(): Promise<RepoInfo> {
    try {
        // Get the URL of the 'origin' remote
        const { stdout: remoteUrl } = await runGitCommand(['remote', 'get-url', 'origin']);
        const url = remoteUrl.trim();
        let user: string | null = null;
        let repo: string | null = null;

        // Try parsing SSH URL format: git@github.com:username/repo.git
        let match = url.match(/git@github\.com:([^\/]+)\/([^\.]+)\.git/);
        if (match) {
            user = match[1];
            repo = match[2];
        } else {
            // Try parsing HTTPS URL format: https://github.com/username/repo.git
            match = url.match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)(\.git)?/);
            if (match) {
                user = match[1];
                repo = match[2];
            }
        }

        // Throw error if user or repo couldn't be parsed
        if (!user || !repo) {
            throw new Error(`Could not parse user/repo from remote URL: ${url}`);
        }

        // Get the current branch name
        const { stdout: branch } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);

        // Return the extracted information
        return { user, repo, branch: branch.trim() };
    } catch (error) {
        // Log error and return nulls if fetching repo info fails
        logger.error(`Failed to get repository info: ${error instanceof Error ? error.message : String(error)}`);
        return { user: null, repo: null, branch: null };
    }
}
