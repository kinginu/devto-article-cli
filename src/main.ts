import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { newArticle } from './commands/newArticle.js';
import { publishArticle } from './commands/publishArticle.js';
import { checkConsistency } from './commands/checkConsistency.js';
import logger from './utils/logger.js';
import type { ArgumentsCamelCase } from 'yargs';

// Check for API key presence
if (!process.env.DEV_TO_API_KEY) {
    logger.error('Error: Dev.to API key is not set in the environment variable DEV_TO_API_KEY.');
    logger.info(`
    Please set the API key using the following instructions. You may need to restart your terminal after setting it.
    (You can get your API key from https://dev.to/settings/account)

    【Windows (Command Prompt/PowerShell)】
      setx DEV_TO_API_KEY "your_api_key"
      or
      [System.Environment]::SetEnvironmentVariable('DEV_TO_API_KEY', 'your_api_key', 'User')

    【macOS (if using zsh - add to ~/.zshrc)】
      echo 'export DEV_TO_API_KEY="your_api_key"' >> ~/.zshrc && source ~/.zshrc

    【Linux (if using bash - add to ~/.bashrc)】
      echo 'export DEV_TO_API_KEY="your_api_key"' >> ~/.bashrc && source ~/.bashrc

    Refer to README.md for detailed instructions.
    `);
    process.exit(1);
}

yargs(hideBin(process.argv))
    .command('new', 'Create a new article boilerplate', () => {}, async (argv: ArgumentsCamelCase) => {
        try {
            await newArticle();
        } catch (error) {
            logger.error('Error during article creation:', error instanceof Error ? error.message : String(error));
        }
    })
    .command('publish', 'Publish or update local articles to Dev.to, automating Git operations', () => {}, async (argv: ArgumentsCamelCase) => {
        try {
            await publishArticle();
        } catch (error) {
            logger.error('Error during article publishing:', error instanceof Error ? error.message : String(error));
        }
    })
    .command('check', 'Check consistency between local articles and Dev.to', () => {}, async (argv: ArgumentsCamelCase) => {
        try {
            await checkConsistency();
        } catch (error) {
            logger.error('Error during consistency check:', error instanceof Error ? error.message : String(error));
        }
    })
    .demandCommand(1, 'Please specify a command to execute (e.g., new, publish, check).')
    .help()
    .alias('h', 'help')
    .strict()
    .parse();