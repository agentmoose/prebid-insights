import * as fs from 'fs';
import type { Logger as WinstonLogger } from 'winston';
import { parse } from 'csv-parse/sync';
import fetch from 'node-fetch';

/**
 * @internal
 * Utility class for fetching and processing URLs from various sources.
 * This class handles loading URLs from local files (txt, csv, json, md)
 * and from GitHub repositories (either by scanning files in a repo
 * or fetching a specific file URL). It includes logic for basic URL
 * validation and extraction.
 */
export class UrlProcessor {
    private logger: WinstonLogger;

    /**
     * Constructs an instance of the UrlProcessor.
     * @param logger - The Winston logger instance for logging messages and errors.
     */
    constructor(logger: WinstonLogger) {
        this.logger = logger;
    }

    /**
     * Loads the content of a file from the local file system.
     *
     * @param filePath - The path to the file to be read.
     * @returns The content of the file as a UTF-8 string, or `null` if an error occurs during reading.
     *          Logs an error if file reading fails.
     * @example
     * ```typescript
     * const content = urlProcessor.loadFileContents('./urls.txt');
     * if (content) {
     *   // Process content
     * }
     * ```
     */
    public loadFileContents(filePath: string): string | null {
        this.logger.info(`Attempting to read file: ${filePath}`);
        try {
            const content: string = fs.readFileSync(filePath, 'utf8');
            this.logger.info(`Successfully read file: ${filePath}`);
            return content;
        } catch (error: any) {
            this.logger.error(`Failed to read file ${filePath}: ${error.message}`, { stack: error.stack });
            return null;
        }
    }

    /**
     * Processes the given string content to extract URLs based on the specified file name's extension.
     * - For `.txt` and `.md` files: Extracts fully qualified URLs and attempts to convert schemeless domains
     *   (e.g., `example.com`) to `https://example.com`.
     * - For `.json` files: Parses the JSON content and recursively extracts all string values that are
     *   valid, fully qualified URLs. If JSON parsing fails, it falls back to a regex scan of the raw content.
     * - For `.csv` files: Assumes URLs are in the first column and extracts them. Skips non-HTTP/S URLs.
     * All extracted URLs are deduplicated.
     *
     * @param fileName - The name of the file (e.g., `urls.txt`, `data.json`). The extension is used
     *                   to determine the URL extraction strategy.
     * @param content - The string content of the file to process.
     * @returns A Promise that resolves to an array of unique URL strings extracted from the content.
     * @example
     * ```typescript
     * const urls = await urlProcessor.processFileContent("links.txt", "Visit example.com and https://another.org");
     * // urls might contain: ["https://example.com", "https://another.org"]
     * ```
     */
    public async processFileContent(fileName: string, content: string): Promise<string[]> {
        const extractedUrls = new Set<string>();
        const urlRegex = /(https?:\/\/[^\s"]+)/gi; // Matches http/https URLs
        // Matches potential domains that might be missing a scheme, looking for patterns like domain.tld
        const schemelessDomainRegex = /(^|\s|"|')([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}(\s|\\"|"|'|$)/g;

        // Initial pass for fully qualified URLs in all file types
        const fqdnMatches = content.match(urlRegex);
        if (fqdnMatches) {
            fqdnMatches.forEach(url => extractedUrls.add(url.trim()));
        }

        if (fileName.endsWith('.txt') || fileName.endsWith('.md')) {
            this.logger.info(`Processing .txt/.md file: ${fileName} for schemeless domains.`);
            const schemelessMatches = content.match(schemelessDomainRegex);
            if (schemelessMatches) {
                schemelessMatches.forEach(domain => {
                    const cleanedDomain = domain.trim().replace(/^["']|["']$/g, ''); // Remove surrounding quotes if any
                    if (cleanedDomain && !cleanedDomain.includes('://')) { // Check if it's truly schemeless
                        const fullUrl = `https://${cleanedDomain}`; // Default to https
                        if (!extractedUrls.has(fullUrl)) { // Avoid adding if already present as FQDN
                            extractedUrls.add(fullUrl);
                            this.logger.info(`Found and added schemeless domain as ${fullUrl} from ${fileName}`);
                        }
                    }
                });
            }
        } else if (fileName.endsWith('.json')) {
            this.logger.info(`Processing .json file: ${fileName}`);
            try {
                const jsonData = JSON.parse(content);
                const urlsFromJson = new Set<string>();

                // Recursively search for URL strings within the JSON structure
                function extractUrlsFromJsonRecursive(data: any) {
                    if (typeof data === 'string') {
                        // Check if the string is a valid URL
                        const jsonStringMatches = data.match(urlRegex);
                        if (jsonStringMatches) {
                            jsonStringMatches.forEach(url => urlsFromJson.add(url.trim()));
                        }
                    } else if (Array.isArray(data)) {
                        data.forEach(item => extractUrlsFromJsonRecursive(item));
                    } else if (typeof data === 'object' && data !== null) {
                        Object.values(data).forEach(value => extractUrlsFromJsonRecursive(value));
                    }
                }

                extractUrlsFromJsonRecursive(jsonData);
                if (urlsFromJson.size > 0) {
                    this.logger.info(`Extracted ${urlsFromJson.size} URLs from parsed JSON structure in ${fileName}`);
                    urlsFromJson.forEach(url => extractedUrls.add(url));
                }
            } catch (e: any) {
                this.logger.warn(`Failed to parse JSON from ${fileName}. Falling back to regex scan of raw content. Error: ${e.message}`);
                // The initial fqdnMatches scan already covers the raw content regex scan as a fallback.
            }
        } else if (fileName.endsWith('.csv')) {
            this.logger.info(`Processing .csv file: ${fileName}`);
            try {
                const records: string[][] = parse(content, {
                    columns: false,
                    skip_empty_lines: true,
                });
                for (const record of records) {
                    if (record && record.length > 0 && typeof record[0] === 'string') {
                        const url = record[0].trim();
                        // Ensure it's a fully qualified HTTP/S URL before adding from CSV
                        if (url.startsWith('http://') || url.startsWith('https://')) {
                            extractedUrls.add(url);
                        } else if (url) { // Log if a non-empty, non-HTTP/S value is found
                            this.logger.warn(`Skipping invalid or non-HTTP/S URL from CSV content in ${fileName}: "${url}"`);
                        }
                    }
                }
                // Log count after processing CSV, distinct from initial regex pass for clarity
                this.logger.info(`Extracted ${extractedUrls.size} URLs after CSV-specific processing of ${fileName}`);
            } catch (e: any) {
                this.logger.warn(`Failed to parse CSV content from ${fileName}. Error: ${e.message}`);
            }
        }
        return Array.from(extractedUrls);
    }

    /**
     * Fetches URLs from a GitHub repository or a direct file link within a GitHub repository.
     * - If `repoUrl` points to a repository (e.g., `https://github.com/owner/repo`), it scans the
     *   root directory for processable files (`.txt`, `.md`, `.json`) and extracts URLs from them.
     * - If `repoUrl` points to a specific file (e.g., `https://github.com/owner/repo/blob/main/file.txt`),
     *   it fetches and processes only that file.
     *
     * @param repoUrl - The URL of the GitHub repository or a direct link to a file.
     * @param numUrls - Optional. The maximum number of unique URLs to fetch. If undefined, all found URLs are returned.
     * @returns A Promise that resolves to an array of unique URL strings. Returns an empty array on error.
     * @example
     * ```typescript
     * const repoUrls = await urlProcessor.fetchUrlsFromGitHub("https://github.com/prebid/prebid-integration-examples", 50);
     * const fileUrls = await urlProcessor.fetchUrlsFromGitHub("https://github.com/prebid/prebid-integration-examples/blob/main/sites.txt");
     * ```
     */
    public async fetchUrlsFromGitHub(repoUrl: string, numUrls?: number): Promise<string[]> {
        this.logger.info(`Fetching URLs from GitHub source: ${repoUrl}`);
        const allExtractedUrls = new Set<string>(); // Use Set for deduplication during collection

        try {
            if (repoUrl.includes('/blob/')) { // Indicates a direct link to a file
                this.logger.info(`Detected direct file link: ${repoUrl}. Attempting to fetch raw content.`);
                const rawUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
                const fileName = repoUrl.substring(repoUrl.lastIndexOf('/') + 1);

                this.logger.info(`Fetching content directly from raw URL: ${rawUrl}`);
                const fileResponse = await fetch(rawUrl);
                if (fileResponse.ok) {
                    const content = await fileResponse.text();
                    const urlsFromFile = await this.processFileContent(fileName, content);
                    urlsFromFile.forEach(url => allExtractedUrls.add(url));
                    this.logger.info(`Extracted ${urlsFromFile.length} URLs from ${rawUrl} (direct file)`);
                } else {
                    this.logger.error(`Failed to download direct file content: ${rawUrl} - ${fileResponse.status} ${fileResponse.statusText}`);
                    const errorBody = await fileResponse.text(); // Attempt to get more error details
                    this.logger.error(`Error body: ${errorBody}`);
                    return [];
                }
            } else { // Process as a repository URL
                this.logger.info(`Processing as repository URL: ${repoUrl}`);
                const repoPathMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
                if (!repoPathMatch || !repoPathMatch[1]) {
                    this.logger.error(`Invalid GitHub repository URL format: ${repoUrl}. Expected format like https://github.com/owner/repo`);
                    return [];
                }
                const repoPath = repoPathMatch[1].replace(/\.git$/, ''); // Remove .git if present
                const contentsUrl = `https://api.github.com/repos/${repoPath}/contents`;
                this.logger.info(`Fetching repository contents list from: ${contentsUrl}`);

                const response = await fetch(contentsUrl, { headers: { Accept: 'application/vnd.github.v3+json' } });

                if (!response.ok) {
                    this.logger.error(`Failed to fetch repository contents list: ${response.status} ${response.statusText}`, { url: contentsUrl });
                    const errorBody = await response.text();
                    this.logger.error(`Error body: ${errorBody}`);
                    return [];
                }

                const files = await response.json() as any[]; // Define a type for GitHub content API if needed
                if (!Array.isArray(files)) {
                    this.logger.error('Expected an array of files from GitHub API, but received different type.', { response: files });
                    return [];
                }

                const targetExtensions = ['.txt', '.md', '.json', '.csv']; // Added .csv
                this.logger.info(`Found ${files.length} items in the repository. Filtering for files ending with: ${targetExtensions.join(', ')}`);

                for (const file of files) {
                    if (numUrls && allExtractedUrls.size >= numUrls) {
                        this.logger.info(`Reached URL limit of ${numUrls}. Stopping further file processing from repository.`);
                        break;
                    }
                    if (file.type === 'file' && file.name && targetExtensions.some(ext => file.name.endsWith(ext))) {
                        this.logger.info(`Fetching content for file: ${file.path} from ${file.download_url}`);
                        try {
                            const fileResponse = await fetch(file.download_url);
                            if (fileResponse.ok) {
                                const content = await fileResponse.text();
                                const urlsFromFile = await this.processFileContent(file.name, content);
                                urlsFromFile.forEach(url => {
                                    if (!numUrls || allExtractedUrls.size < numUrls) {
                                        allExtractedUrls.add(url);
                                    }
                                });
                                this.logger.info(`Extracted ${urlsFromFile.length} URLs from ${file.path}. Total unique URLs so far: ${allExtractedUrls.size}`);
                            } else {
                                this.logger.warn(`Failed to download file content: ${file.path} - ${fileResponse.status}`);
                            }
                        } catch (fileError: any) {
                            this.logger.error(`Error fetching or processing file ${file.path}: ${fileError.message}`, { fileUrl: file.download_url, stack: fileError.stack });
                        }
                    }
                }
            }

            const uniqueUrlsArray = Array.from(allExtractedUrls);
            this.logger.info(`Total unique URLs extracted before applying numUrls limit: ${uniqueUrlsArray.length}`);

            // Apply numUrls limit if it's defined and less than the number of unique URLs found
            return numUrls && uniqueUrlsArray.length > numUrls ? uniqueUrlsArray.slice(0, numUrls) : uniqueUrlsArray;

        } catch (error: any) {
            this.logger.error(`Error processing GitHub URL ${repoUrl}: ${error.message}`, { stack: error.stack });
            return []; // Return empty array on error
        }
    }
}
