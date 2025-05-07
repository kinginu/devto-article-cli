import { execa } from 'execa';
import logger from './logger.js';

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

async function runGitCommand(args: string[], options: Record<string, any> = {}): Promise<GitResponse> {
    try {
        const result = await execa('git', args, options);
        const { stdout = '', stderr = '', exitCode = 0 } = result;
        
        if (exitCode === 0 && stderr && !stderr.includes('nothing to commit, working tree clean') && !stderr.includes('On branch')) {
            logger.warn(`Git command STDERR (but successful): ${stderr}`);
        }
        return { stdout, stderr, exitCode };
    } catch (error: any) {
        logger.error(`Git command execution error (git ${args.join(' ')}): ${error.shortMessage || error.message}`);
        if (error.stderr) logger.error(`Git STDERR: ${error.stderr}`);
        if (error.stdout) logger.info(`Git STDOUT: ${error.stdout}`);
        throw error;
    }
}

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

        if (!user || !repo) {
            throw new Error(`Could not parse user/repo from remote URL: ${url}`);
        }

        const { stdout: branch } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);

        return { user, repo, branch: branch.trim() };
    } catch (error) {
        logger.error(`Failed to get repository info: ${error instanceof Error ? error.message : String(error)}`);
        return { user: null, repo: null, branch: null };
    }
}