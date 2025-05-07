import axios, { AxiosInstance } from 'axios';
import logger from './logger.js';

const DEVTO_API_URL = 'https://dev.to/api';
const API_KEY = process.env.DEV_TO_API_KEY;

interface DevToArticle {
    id: number;
    title: string;
    description?: string;
    tags?: string[];
    series?: string | null;
    canonical_url?: string | null;
    url?: string;
    body_markdown: string;
    published?: boolean;
    organization_id?: number | null;
}

interface DevToArticlePayload {
    article: {
        title: string;
        body_markdown: string;
        published?: boolean;
        tags?: string[];
        series?: string | null;
        main_image?: string | null;
        canonical_url?: string | null;
        description?: string;
        organization_id?: number | null;
    };
}

const apiClient: AxiosInstance = axios.create({
    baseURL: DEVTO_API_URL,
    headers: {
        'api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.forem.api-v1+json',
    },
    timeout: 20000, // 20 seconds timeout
});

apiClient.interceptors.response.use(
    response => {
        const rateLimitRemaining = response.headers['ratelimit-remaining'];
        if (rateLimitRemaining) {
            logger.debug(`Dev.to API Rate Limit Remaining: ${rateLimitRemaining}`);
        }
        return response;
    },
    error => {
        if (error.response) {
            logger.error(`API Error: ${error.response.status} - ${error.response.statusText}. URL: ${error.config.method.toUpperCase()} ${error.config.url}`);
            if (error.response.data?.error) {
                logger.error(`Dev.to Error Message: ${error.response.data.error}`);
            } else if (error.response.data && Object.keys(error.response.data).length > 0) {
                logger.debug('API Error Data:', JSON.stringify(error.response.data, null, 2));
            }
        } else if (error.request) {
            logger.error(`API Error: No response received from server for ${error.config.method.toUpperCase()} ${error.config.url}. Check network connection.`);
        } else {
            logger.error('API Error: Error in request setup.', error.message);
        }
        return Promise.reject(error);
    }
);

export async function createArticle(payload: DevToArticlePayload): Promise<DevToArticle> {
    try {
        const response = await apiClient.post('/articles', payload);
        return response.data;
    } catch (error) {
        logger.error('Context: Failed to create article on Dev.to API.');
        throw error;
    }
}

export async function updateArticle(articleId: number, payload: DevToArticlePayload): Promise<DevToArticle> {
    try {
        const response = await apiClient.put(`/articles/${articleId}`, payload);
        return response.data;
    } catch (error) {
        logger.error(`Context: Failed to update article (ID: ${articleId}) on Dev.to API.`);
        throw error;
    }
}

export async function getArticleById(articleId: number): Promise<DevToArticle | null> {
    try {
        const response = await apiClient.get(`/articles/${articleId}`);
        return response.data;
    } catch (error) {
        // Error already logged by interceptor
        throw error;
    }
}

export async function getMyPublishedArticles(): Promise<DevToArticle[]> {
    try {
        const response = await apiClient.get('/articles/me/published', { params: { per_page: 100 } });
        return response.data;
    } catch (error) {
        logger.error('Context: Failed to fetch user\'s published articles from Dev.to API.');
        throw error;
    }
}