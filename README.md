
# All-in-One GitHub Repository-Driven Dev.to Article Management System

Welcome to `devto-article-cli`!

This repository is designed to be your **central hub for managing Dev.to articles**.

It not only contains the Node.js command-line tool itself but also serves as the primary storage and version control system for your article content (typically within the `articles/` directory). The included CLI scripts empower you to seamlessly create, edit (in Markdown), version with Git, and publish your Dev.to articles directly from this integrated, local-first environment.

This README is also intended to be interpretable by AI agents (e.g., GitHub Copilot, VSCode AI assistants) to facilitate their use of this tool.



## Features

-   Write articles locally and use Git for version control.
    
-   Publish new articles and update existing ones on Dev.to with simple commands.
    
-   Automatically appends Dev.to article ID to Markdown files upon publishing.
    
-   **Automatic Image Handling**: Converts local relative image paths in your Markdown to absolute GitHub URLs when publishing to Dev.to, while keeping your local files unchanged for easy previewing.
    
-   Check consistency between local articles and Dev.to.
    
-   No CI needed; everything is handled in your local environment.
    
-   Fully automates `git add`, `git commit`, and `git push` for the publishing workflow.
    
-   Compliant with the latest [Forem API V1 (1.0.0)](https://developers.forem.com/api).



## Prerequisites (For Users and AI Agents)

-   Node.js (LTS recommended)
    
-   Git
    
-   Dev.to account and API Key
    

## Setup (For Users and AI Agents)

1.  Fork this Repository (Recommended for Users):
    
    If you intend to use this tool to manage your articles, first fork the devto-article-cli repository to your own GitHub account. This creates your personal copy where your articles will be stored.
    
2.  **Clone Your Forked Repository**:
    
    ```
    git clone https://github.com/YOUR_USERNAME/devto-article-cli.git
    cd devto-article-cli
    # Replace YOUR_USERNAME with your GitHub username.
    ```
    
3.  Install Dependencies:
    
    Navigate to the cloned/created directory and install the necessary Node.js packages:
    
    ```
    npm install
    ```

4.  Build TypeScript: 
    
    This process will generate `dist` directory:
    
    ```
    npm run build
    ```
    
5.  Set Dev.to API Key:
    
    Obtain your API key from your Dev.to Settings > Extensions page.

    ![image](https://gist.github.com/user-attachments/assets/e54343ac-ae6d-4546-84e2-6a2e703c3312)

    
    ![image](https://gist.github.com/user-attachments/assets/a7fbbe6c-eece-455a-b0db-6cd7e3ab8e63)


    Set it as an OS environment variable named `DEV_TO_API_KEY`.
    
    -   **Windows (Command Prompt/PowerShell)**:
        
        ```
        # Command Prompt
        setx DEV_TO_API_KEY "your_api_key"
        # PowerShell
        [System.Environment]::SetEnvironmentVariable('DEV_TO_API_KEY', 'your_api_key', 'User')
        ```
        
        Restart your terminal after setting.
        
    -   macOS (if using zsh):
        
        Add to ~/.zshrc:
     
        ```
        echo 'export DEV_TO_API_KEY="your_api_key"' >> ~/.zshrc && source ~/.zshrc
        ```
        
    -   Linux (if using bash):
        
        Add to ~/.bashrc:
        
        ```
        echo 'export DEV_TO_API_KEY="your_api_key"' >> ~/.bashrc && source ~/.bashrc
        ```
        
    
    If this environment variable is not set when the script runs, a message prompting you to set it will be displayed.
    
6.  Initial Git Configuration (Important!):
    
    Ensure your Git remote origin points to your forked repository on GitHub. If you cloned your fork, this should be set correctly. You may need to configure your Git user name and email if you haven't already:
    
    ```
    git config --global user.name "Your Name"
    git config --global user.email "your.email@example.com"
    ```
    
7.  Ready to Go!:
    
    You are now set up. Use the commands below to manage your articles. Changes will be pushed to your forked repository.
    

## Usage (For Users and AI Agents)

This tool provides three core commands. AI agents should be instructed to use these commands as described.

### Creating a New Article (`article:new`)

To create a new article boilerplate:

```
npm run article:new
```

**AI Agent Interaction**:

1.  Execute the command `npm run article:new`.
    
2.  The script will prompt: "Enter the title of the article:". Provide the desired article title.
    
3.  The script will then prompt: "Enter the slug for the filename (e.g., my-awesome-post):". Provide a URL-friendly slug.
    
4.  A new Markdown file (e.g., `articles/YYYY-MM-DD-HH-mm-ss-slug.md`) will be created. Its front-matter will include the title and `published: false`.
    
5.  The AI agent should then populate this file with the article content. **For images**, save them within this repository (e.g., in `articles/images/`) and use **relative paths** in the Markdown (e.g., `![My Alt Text](./images/cool-pic.png)`).
    

### Publishing/Updating Articles (`article:publish`)

To publish new articles or update existing ones (from the `articles/` directory) to Dev.to and sync with GitHub:

```
npm run article:publish
```

**AI Agent Interaction**:

1.  Ensure the article content within the `.md` files in the `articles/` directory is complete and ready for publishing. Ensure any images used are committed to the repository and referenced using relative paths in the Markdown. Adjust the `published` field in the front-matter to `true` if the article should go live.
    
2.  Execute the command `npm run article:publish`.
    
3.  The script will automatically:
    
    -   Scan all `.md` files in the `articles/` directory.
        
    -   **Convert local relative image paths to absolute GitHub Raw URLs** temporarily for sending to Dev.to.
        
    -   For new articles (no `dev_to_article_id`): Post to Dev.to and add the new ID to the local file's front-matter.
        
    -   For existing articles (`dev_to_article_id` present): Update the article on Dev.to.
        
    -   `git add` all processed and modified local files (including images if they were added/changed and the article file).
        
    -   `git commit` these changes with a summary message.
        
    -   `git push` the commit to the remote GitHub repository.
        
4.  No manual Git commands are needed from the AI agent for this step. Console logs will indicate success or failure.
    

### Checking Consistency (`article:check`)

To check for discrepancies between local articles and those on Dev.to:

```
npm run article:check
```

**AI Agent Interaction**:

1.  Execute the command `npm run article:check`.
    
2.  The script will report:
    
    -   Local articles with IDs: Verifies their existence and title on Dev.to.
        
    -   Local articles without IDs: Lists them as unpublished.
        
    -   Dev.to articles: Checks if corresponding local files (by ID) exist.
        
3.  The AI agent can parse the console output to understand the consistency status and inform the user or take further actions if discrepancies are critical. This command is read-only.
    

## Front-matter (For AI Agents)

At the beginning of your article Markdown files, include YAML front-matter like the following:

```
---
title: "My Awesome Article Title"
published: false # true to publish, false to send as draft to Dev.to. Default is false.
tags: ["javascript", "tutorial", "webdev"] # Array of tags
series: "Intermediate JavaScript Series" # Optional
# Use absolute URLs for main_image and canonical_url if needed
main_image: "https://..." # Optional: URL to the main image
canonical_url: "https://..." # Optional: URL to the original source
description: "This article explains advanced JavaScript techniques." # Optional
# dev_to_article_id: 12345 # Automatically added/updated on publish
---

## Article Body Starts Here
Write freely in Markdown...

Include images using relative paths to files within this repository:
![Alt text for my image](./images/my-local-image.jpg)
```

## Troubleshooting (For AI Agents)

-   **API Key Error**: Ensure the `DEV_TO_API_KEY` environment variable is correctly set.
    
-   **Git Error**: Ensure your Git authentication (SSH keys or HTTPS credentials) is correctly set up for pushing to your remote repository. Ensure you have committed initial files if it's a new repository and that the remote `origin` is correctly configured.
    
-   **Image Not Found on Dev.to**: Ensure the image file exists in your repository at the path referenced in the Markdown, and that you have pushed the commit containing the image _before_ running `publish`. The automatic URL conversion relies on the image being accessible via its GitHub Raw URL.
    
-   If other error messages appear, check their content.