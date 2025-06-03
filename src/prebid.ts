import * as fs from 'fs';
import { initializeLogger } from './utils/logger.js';
import type { Logger as WinstonLogger } from 'winston';
import { addExtra } from 'puppeteer-extra';
import puppeteerVanilla, { Browser, PuppeteerLaunchOptions } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import blockResourcesPluginFactory from 'puppeteer-extra-plugin-block-resources';
import { Cluster } from 'puppeteer-cluster';
import { Page } from 'puppeteer';
import { parse } from 'csv-parse/sync';
import fetch from 'node-fetch'; // Ensure fetch is available, already used by fetchUrlsFromGitHub

// Helper function to configure a new page
async function configurePage(page: Page): Promise<Page> { // page is passed directly by puppeteer-cluster
    page.setDefaultTimeout(55000);
    // Set to a common Chrome user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    return page;
}

// Define interfaces for page data
interface PrebidInstance {
    globalVarName: string;
    version: string;
    modules: string[];
}

interface PageData {
    libraries: string[];
    date: string;
    prebidInstances?: PrebidInstance[];
    url?: string; // Added url to PageData
}

interface TaskResultSuccess {
    type: 'success';
    data: PageData;
}

interface TaskResultNoData {
    type: 'no_data';
    url: string;
}

interface TaskResultError {
    type: 'error';
    url: string;
    error: string;
}

type TaskResult = TaskResultSuccess | TaskResultNoData | TaskResultError;

export interface PrebidExplorerOptions {
    inputFile?: string; // Make optional as it might not be needed if githubRepo is used
    csvFile?: string;
    githubRepo?: string;
    numUrls?: number;
    puppeteerType: 'vanilla' | 'cluster';
    concurrency: number;
    headless: boolean;
    monitor: boolean;
    outputDir: string;
    logDir: string;
    puppeteerLaunchOptions?: PuppeteerLaunchOptions;
    range?: string;
    chunkSize?: number;
}

let logger: WinstonLogger;

const puppeteer = addExtra(puppeteerVanilla as any);

// Helper function to process file content for URL extraction
async function processFileContent(fileName: string, content: string, logger: WinstonLogger): Promise<string[]> {
    const extractedUrls = new Set<string>(); // Use Set for automatic deduplication
    const urlRegex = /(https?:\/\/[^\s"]+)/gi;
    const schemelessDomainRegex = /(^|\s|"|')([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}(\s|\\"|"|'|$)/g; // Adjusted to handle quotes and escaped quotes

    // Always try to find fully qualified URLs first
    const fqdnMatches = content.match(urlRegex);
    if (fqdnMatches) {
        fqdnMatches.forEach(url => extractedUrls.add(url.trim()));
    }

    if (fileName.endsWith('.txt')) {
        logger.info(`Processing .txt file: ${fileName} for schemeless domains.`);
        // Find schemeless domains
        const schemelessMatches = content.match(schemelessDomainRegex);
        if (schemelessMatches) {
            schemelessMatches.forEach(domain => {
                const cleanedDomain = domain.trim().replace(/^["']|["']$/g, ''); // Remove surrounding quotes
                if (cleanedDomain && !cleanedDomain.includes('://')) { // Ensure it's actually schemeless
                    const fullUrl = `https://${cleanedDomain}`;
                    if (!extractedUrls.has(fullUrl)) { // Avoid adding if already found as FQDN
                        extractedUrls.add(fullUrl);
                        logger.info(`Found and added schemeless domain as ${fullUrl} from ${fileName}`);
                    }
                }
            });
        }
    } else if (fileName.endsWith('.json')) {
        logger.info(`Processing .json file: ${fileName}`);
        try {
            const jsonData = JSON.parse(content);
            const urlsFromJson = new Set<string>();

            function extractUrlsFromJsonRecursive(data: any) {
                if (typeof data === 'string') {
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
                logger.info(`Extracted ${urlsFromJson.size} URLs from parsed JSON structure in ${fileName}`);
                urlsFromJson.forEach(url => extractedUrls.add(url));
            }
        } catch (e: any) {
            logger.warn(`Failed to parse JSON from ${fileName}. Falling back to regex scan of raw content. Error: ${e.message}`);
            // Fallback is covered by the initial fqdnMatches scan at the beginning of the function
        }
    }
    // For other file types (e.g., .md), the initial fqdnMatches scan is sufficient.

    return Array.from(extractedUrls);
}

// Helper function to fetch URLs from GitHub
async function fetchUrlsFromGitHub(repoUrl: string, numUrls: number | undefined, logger: WinstonLogger): Promise<string[]> {
  logger.info(`Fetching URLs from GitHub repository source: ${repoUrl}`);

  const allExtractedUrls: string[] = []; // Changed to allExtractedUrls to avoid confusion with Set in processFileContent


  try {
    // Check if the URL is a direct link to a file view (contains /blob/)
    if (repoUrl.includes('/blob/')) {
      logger.info(`Detected direct file link: ${repoUrl}. Attempting to fetch raw content.`);
      const rawUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
      const fileName = repoUrl.substring(repoUrl.lastIndexOf('/') + 1); // Extract filename

      logger.info(`Fetching content directly from raw URL: ${rawUrl}`);
      const fileResponse = await fetch(rawUrl);
      if (fileResponse.ok) {
        const content = await fileResponse.text();
        const urlsFromFile = await processFileContent(fileName, content, logger);
        if (urlsFromFile.length > 0) {
          urlsFromFile.forEach(url => allExtractedUrls.push(url));
          logger.info(`Extracted ${urlsFromFile.length} URLs from ${rawUrl} (direct file)`);
        } else {
          logger.info(`No URLs found in content from ${rawUrl} (direct file)`);
        }
      } else {
        logger.error(`Failed to download direct file content: ${rawUrl} - ${fileResponse.status} ${fileResponse.statusText}`);
        const errorBody = await fileResponse.text();
        logger.error(`Error body: ${errorBody}`);
        return []; // Return empty if direct file fetch fails
      }
    } else {
      // Existing logic for repository directory listing
      logger.info(`Processing as repository URL: ${repoUrl}`);
      const repoPathMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      if (!repoPathMatch || !repoPathMatch[1]) {
        logger.error(`Invalid GitHub repository URL format: ${repoUrl}. Expected format like https://github.com/owner/repo`);
        return [];
      }
      const repoPath = repoPathMatch[1].replace(/\.git$/, '');

      const contentsUrl = `https://api.github.com/repos/${repoPath}/contents`;
      logger.info(`Fetching repository contents from: ${contentsUrl}`);

      const response = await fetch(contentsUrl, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });

      if (!response.ok) {
        logger.error(`Failed to fetch repository contents: ${response.status} ${response.statusText}`, { url: contentsUrl });
        const errorBody = await response.text();
        logger.error(`Error body: ${errorBody}`);
        return [];
      }

      const files = await response.json();
      if (!Array.isArray(files)) {
        logger.error('Expected an array of files from GitHub API, but received something else.', { response: files });
        return [];
      }

      // Updated to include .json for targeted processing, .txt and .md for general URL extraction.
      const targetExtensions = ['.txt', '.md', '.json'];
      logger.info(`Found ${files.length} items in the repository. Filtering for ${targetExtensions.join(', ')} files.`);

      for (const file of files) {
        // Ensure file.name is defined before calling endsWith
        if (file.type === 'file' && file.name && targetExtensions.some(ext => file.name.endsWith(ext))) {
          logger.info(`Fetching content for file: ${file.path} from ${file.download_url}`);
          try {
            const fileResponse = await fetch(file.download_url);
            if (fileResponse.ok) {
              const content = await fileResponse.text();
              const urlsFromFile = await processFileContent(file.name, content, logger);
              if (urlsFromFile.length > 0) {
                urlsFromFile.forEach(url => allExtractedUrls.push(url));
                logger.info(`Extracted ${urlsFromFile.length} URLs from ${file.path}`);
              }
            } else {
              logger.warn(`Failed to download file content: ${file.path} - ${fileResponse.status}`);
            }
          } catch (fileError: any) {
            logger.error(`Error fetching or processing file ${file.path}: ${fileError.message}`, { fileUrl: file.download_url });
          }

          if (numUrls && allExtractedUrls.length >= numUrls) {
            logger.info(`Reached URL limit of ${numUrls}. Stopping further file processing.`);
            break;
          }
        }
      }
    }
    // Deduplicate URLs at the end before slicing
    const uniqueUrls = Array.from(new Set(allExtractedUrls));
    logger.info(`Total unique URLs extracted before limiting: ${uniqueUrls.length}`);
    return numUrls ? uniqueUrls.slice(0, numUrls) : uniqueUrls;

  } catch (error: any) {
    logger.error(`Error processing GitHub URL ${repoUrl}: ${error.message}`, { stack: error.stack });
    return [];
  }
}

// Helper function to fetch URLs from a CSV file (local or remote)
async function fetchUrlsFromCsv(csvPathOrUrl: string, logger: WinstonLogger): Promise<string[]> {
  logger.info(`Fetching URLs from CSV source: ${csvPathOrUrl}`);
  const extractedUrls: string[] = [];
  let content: string;

  try {
    if (csvPathOrUrl.startsWith('http://') || csvPathOrUrl.startsWith('https://')) {
      logger.info(`Detected remote CSV URL: ${csvPathOrUrl}`);
      let fetchUrl = csvPathOrUrl;
      // Transform GitHub blob URLs to raw content URLs
      if (fetchUrl.includes('github.com') && fetchUrl.includes('/blob/')) {
        fetchUrl = fetchUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
        logger.info(`Transformed GitHub blob URL to raw content URL: ${fetchUrl}`);
      }

      const response = await fetch(fetchUrl);
      if (!response.ok) {
        logger.error(`Failed to download CSV content from ${fetchUrl}: ${response.status} ${response.statusText}`);
        const errorBody = await response.text();
        logger.error(`Error body: ${errorBody}`);
        return [];
      }
      content = await response.text();
    } else {
      logger.info(`Reading local CSV file: ${csvPathOrUrl}`);
      content = fs.readFileSync(csvPathOrUrl, 'utf8');
    }

    const records = parse(content, {
      columns: false,
      skip_empty_lines: true,
    });

    for (const record of records) {
      if (record && record.length > 0 && typeof record[0] === 'string') {
        const url = record[0].trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
          extractedUrls.push(url);
        } else if (url) {
          logger.warn(`Skipping invalid or non-HTTP/S URL from CSV: "${url}"`);
        }
      }
    }
    logger.info(`Extracted ${extractedUrls.length} URLs from CSV: ${csvPathOrUrl}`);
  } catch (error: any) {
    logger.error(`Error processing CSV from ${csvPathOrUrl}: ${error.message}`, { stack: error.stack });
    return [];
  }
  return extractedUrls;
}


export async function prebidExplorer(options: PrebidExplorerOptions): Promise<void> {
    logger = initializeLogger(options.logDir);

    // Apply puppeteer-extra plugins
    puppeteer.use(StealthPlugin());

    const blockResources = (blockResourcesPluginFactory as any)();
    if (blockResources && blockResources.blockedTypes && typeof blockResources.blockedTypes.add === 'function') {
      const typesToBlock: Set<any> = new Set<any>([
          'image', 'font', 'websocket', 'media',
          'texttrack', 'eventsource', 'manifest', 'other'
      ]);
      typesToBlock.forEach(type => blockResources.blockedTypes.add(type));
      puppeteer.use(blockResources); // Use the configured instance
    } else {
      logger.warn('Could not configure blockResourcesPlugin: blockedTypes property or .add method not available on instance.', { plugin: blockResources });
    }

    const basePuppeteerOptions: PuppeteerLaunchOptions = {
        protocolTimeout: 1000000,
        defaultViewport: null,
        headless: options.headless,
        args: options.puppeteerLaunchOptions?.args || [],
        ...options.puppeteerLaunchOptions
    };

    let results: PageData[] = [];
    const taskResults: TaskResult[] = [];
    let allUrls: string[] = [];
    const processedUrls: Set<string> = new Set();
    let urlSourceType = ''; // To track the source for logging and file updates

    if (options.csvFile) {
        urlSourceType = 'CSV';
        allUrls = await fetchUrlsFromCsv(options.csvFile, logger);
        if (allUrls.length > 0) {
            logger.info(`Successfully loaded ${allUrls.length} URLs from CSV file: ${options.csvFile}`);
        } else {
            logger.warn(`No URLs found or fetched from CSV file: ${options.csvFile}.`);
        }
    } else if (options.githubRepo) {
        urlSourceType = 'GitHub';
        allUrls = await fetchUrlsFromGitHub(options.githubRepo, options.numUrls, logger);
        if (allUrls.length > 0) {
            logger.info(`Successfully loaded ${allUrls.length} URLs from GitHub repository: ${options.githubRepo}`);
        } else {
            logger.warn(`No URLs found or fetched from GitHub repository: ${options.githubRepo}.`);
        }
    } else if (options.inputFile) {
        urlSourceType = 'InputFile';
        try {
            allUrls = fs.readFileSync(options.inputFile, 'utf8').split('\n').map((url: string) => url.trim()).filter((url: string) => url.length > 0);
            logger.info(`Initial URLs read from ${options.inputFile}`, { count: allUrls.length });
        } catch (fileError: any) {
            logger.error(`Failed to read input file ${options.inputFile}: ${fileError.message}`);
            throw new Error(`Failed to read input file: ${options.inputFile}`);
        }
    } else {
        // This case should ideally be prevented by CLI validation in scan.ts
        logger.error('No URL source provided. Either --csvFile, --githubRepo, or inputFile argument must be specified.');
        throw new Error('No URL source specified.');
    }

    if (allUrls.length === 0) {
        logger.warn(`No URLs to process from ${urlSourceType || 'any specified source'}. Exiting.`);
        return;
    }
    logger.info(`Initial total URLs found: ${allUrls.length}`, { firstFew: allUrls.slice(0, 5) });

    // 1. URL Range Logic
    if (options.range) {
        logger.info(`Applying range: ${options.range}`);
        const originalUrlCount = allUrls.length;
        let [startStr, endStr] = options.range.split('-');
        let start = startStr ? parseInt(startStr, 10) : 1;
        let end = endStr ? parseInt(endStr, 10) : allUrls.length;

        if (isNaN(start) || isNaN(end) || start < 0 || end < 0) { // Allow start = 0 for internal 0-based, but user input is 1-based
            logger.warn(`Invalid range format: "${options.range}". Proceeding with all URLs. Start and end must be numbers. User input is 1-based.`);
        } else {
            // Convert 1-based to 0-based indices
            start = start > 0 ? start - 1 : 0; // If user enters 0 or negative, treat as start from beginning
            end = end > 0 ? end : allUrls.length; // If user enters 0 or negative for end, or leaves it empty, treat as end of list

            if (start >= allUrls.length) {
                logger.warn(`Start of range (${start + 1}) is beyond the total number of URLs (${allUrls.length}). No URLs to process.`);
                allUrls = [];
            } else if (start > end -1) {
                 logger.warn(`Start of range (${start + 1}) is greater than end of range (${end}). Proceeding with URLs from start to end of list.`);
                 allUrls = allUrls.slice(start);
            }
            else {
                allUrls = allUrls.slice(start, end); // end is exclusive for slice, matches 0-based end index
                logger.info(`Applied range: Processing URLs from ${start + 1} to ${Math.min(end, originalUrlCount)} (0-based index ${start} to ${Math.min(end, originalUrlCount) -1}). Total URLs after range: ${allUrls.length} (out of ${originalUrlCount}).`);
            }
        }
    }

    if (allUrls.length === 0) {
        logger.warn(`No URLs to process after applying range or due to empty initial list. Exiting.`);
        return;
    }
    logger.info(`Total URLs to process after range check: ${allUrls.length}`, { firstFew: allUrls.slice(0, 5) });

    const urlsToProcess = allUrls; // This now contains potentially ranged URLs

    // Define the core processing task (used by both vanilla and cluster)
    const processPageTask = async (page: Page, url: string): Promise<TaskResult> => {
        const trimmedUrl: string = url;
        logger.info(`Processing: ${trimmedUrl}`, { url: trimmedUrl });
        try {
            await configurePage(page);
            await page.goto(trimmedUrl, { timeout: 60000, waitUntil: 'networkidle2' });

            await page.evaluate(async () => {
                const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
                await sleep(6000);
            });

            const pageData: PageData = await page.evaluate((): PageData => {
                const data: Partial<PageData> = {};
                data.libraries = [];
                data.date = new Date().toISOString().slice(0, 10);
                if ((window as any).apstag) data.libraries.push('apstag');
                if ((window as any).googletag) data.libraries.push('googletag');
                if ((window as any).ats) data.libraries.push('ats');
                if ((window as any)._pbjsGlobals && Array.isArray((window as any)._pbjsGlobals)) {
                    data.prebidInstances = [];
                    (window as any)._pbjsGlobals.forEach(function(globalVarName: string) {
                        const pbjsInstance = (window as any)[globalVarName];
                        if (pbjsInstance && pbjsInstance.version && pbjsInstance.installedModules) {
                            data.prebidInstances!.push({
                                globalVarName: globalVarName,
                                version: pbjsInstance.version,
                                modules: pbjsInstance.installedModules
                            });
                        }
                    });
                }
                return data as PageData;
            });
            pageData.url = trimmedUrl;
            if (pageData.libraries.length > 0 || (pageData.prebidInstances && pageData.prebidInstances.length > 0)) {
                return { type: 'success', data: pageData };
            } else {
                logger.warn(`No relevant Prebid or ad library data found for ${trimmedUrl}`, { url: trimmedUrl });
                return { type: 'no_data', url: trimmedUrl };
            }
        } catch (pageError: any) {
            logger.error(`Error processing ${trimmedUrl}`, { url: trimmedUrl, error: pageError });
            const errorMessage: string = pageError.message || '';
            const netErrorMatch: RegExpMatchArray | null = errorMessage.match(/net::([A-Z_]+)/);
            let errorCode: string;
            if (netErrorMatch) {
                errorCode = netErrorMatch[1];
            } else {
                const prefix: string = `Error processing ${trimmedUrl}: `;
                if (errorMessage.startsWith(prefix)) {
                    errorCode = errorMessage.substring(prefix.length).trim();
                } else {
                    errorCode = errorMessage.trim() || 'UNKNOWN_ERROR';
                }
                errorCode = errorCode.replace(/\s+/g, '_').toUpperCase();
            }
            return { type: 'error', url: trimmedUrl, error: errorCode };
        }
    };

    // 2. Chunk Processing Logic
    const chunkSize = options.chunkSize && options.chunkSize > 0 ? options.chunkSize : 0;

    if (chunkSize > 0) {
        logger.info(`Chunked processing enabled. Chunk size: ${chunkSize}`);
        const totalChunks = Math.ceil(urlsToProcess.length / chunkSize);
        logger.info(`Total chunks to process: ${totalChunks}`);

        for (let i = 0; i < urlsToProcess.length; i += chunkSize) {
            const currentChunkUrls = urlsToProcess.slice(i, i + chunkSize);
            const chunkNumber = Math.floor(i / chunkSize) + 1;
            logger.info(`Processing chunk ${chunkNumber} of ${totalChunks}: URLs ${i + 1}-${Math.min(i + chunkSize, urlsToProcess.length)}`);

            if (options.puppeteerType === 'cluster') {
                const cluster: Cluster<string, TaskResult> = await Cluster.launch({
                    concurrency: Cluster.CONCURRENCY_CONTEXT,
                    maxConcurrency: options.concurrency,
                    monitor: options.monitor,
                    puppeteer,
                    puppeteerOptions: basePuppeteerOptions,
                });

                await cluster.task(async ({ page, data: url }: { page: Page, data: string }): Promise<TaskResult> => {
                    return processPageTask(page, url);
                });

                try {
                    const chunkPromises = currentChunkUrls.filter(url => url).map(url => {
                        processedUrls.add(url); // Add to global processedUrls as it's queued
                        return cluster.queue(url)
                            .then(resultFromQueue => resultFromQueue)
                            .catch(error => {
                                logger.error(`Error from cluster.queue for ${url} in chunk ${chunkNumber}:`, { error });
                                return { type: 'error', url: url, error: 'QUEUE_ERROR_OR_TASK_FAILED' } as TaskResult;
                            });
                    });
                    const settledChunkResults = await Promise.allSettled(chunkPromises);
                    settledChunkResults.forEach(settledResult => {
                        if (settledResult.status === 'fulfilled') {
                            if (settledResult.value !== undefined && settledResult.value !== null) {
                                taskResults.push(settledResult.value);
                            } else {
                                logger.warn('A task from cluster.queue (chunked) settled with undefined/null value.', { settledResult });
                            }
                        } else {
                            logger.error(`A promise from cluster.queue (chunk ${chunkNumber}) settled as rejected.`, { reason: settledResult.reason });
                        }
                    });
                    await cluster.idle();
                    await cluster.close();
                } catch (error: any) {
                    logger.error(`An error occurred during processing chunk ${chunkNumber} with puppeteer-cluster.`, { error });
                    if (cluster) await cluster.close(); // Ensure cluster is closed on error
                }
            } else { // 'vanilla' Puppeteer for the current chunk
                let browser: Browser | null = null;
                try {
                    browser = await puppeteer.launch(basePuppeteerOptions);
                    for (const url of currentChunkUrls) {
                        if (url) {
                            const page = await browser.newPage();
                            const result = await processPageTask(page, url);
                            taskResults.push(result);
                            await page.close();
                            processedUrls.add(url); // Add to global processedUrls
                        }
                    }
                } catch (error: any) {
                    logger.error(`An error occurred during processing chunk ${chunkNumber} with vanilla Puppeteer.`, { error });
                } finally {
                    if (browser) await browser.close();
                }
            }
            logger.info(`Finished processing chunk ${chunkNumber} of ${totalChunks}.`);
        }
    } else {
        // Process all URLs at once (no chunking)
        logger.info(`Processing all ${urlsToProcess.length} URLs without chunking.`);
        if (options.puppeteerType === 'cluster') {
            const cluster: Cluster<string, TaskResult> = await Cluster.launch({
                concurrency: Cluster.CONCURRENCY_CONTEXT,
                maxConcurrency: options.concurrency,
                monitor: options.monitor,
                puppeteer,
                puppeteerOptions: basePuppeteerOptions,
            });

            await cluster.task(async ({ page, data: url }: { page: Page, data: string }): Promise<TaskResult> => {
                return processPageTask(page, url);
            });

            try {
                const promises = urlsToProcess.filter(url => url).map(url => {
                    processedUrls.add(url);
                    return cluster.queue(url)
                        .then(resultFromQueue => resultFromQueue)
                        .catch(error => {
                            logger.error(`Error from cluster.queue for ${url}:`, { error });
                            return { type: 'error', url: url, error: 'QUEUE_ERROR_OR_TASK_FAILED' } as TaskResult;
                        });
                });
                const settledResults = await Promise.allSettled(promises);
                settledResults.forEach(settledResult => {
                    if (settledResult.status === 'fulfilled') {
                        if (settledResult.value !== undefined && settledResult.value !== null) {
                            taskResults.push(settledResult.value);
                        } else {
                            logger.warn('A task from cluster.queue (non-chunked) settled with undefined/null value.', { settledResult });
                        }
                    } else {
                        logger.error('A promise from cluster.queue settled as rejected.', { reason: settledResult.reason });
                    }
                });
                await cluster.idle();
                await cluster.close();
            } catch (error: any) {
                logger.error("An unexpected error occurred during cluster processing orchestration", { error });
                if (cluster) await cluster.close();
            }
        } else { // 'vanilla' Puppeteer
            let browser: Browser | null = null;
            try {
                browser = await puppeteer.launch(basePuppeteerOptions);
                for (const url of urlsToProcess) {
                    if (url) {
                        const page = await browser.newPage();
                        const result = await processPageTask(page, url);
                        taskResults.push(result);
                        await page.close();
                        processedUrls.add(url);
                    }
                }
            } catch (error: any) {
                logger.error("An unexpected error occurred during vanilla Puppeteer processing", { error });
            } finally {
                if (browser) await browser.close();
            }
        }
    }

    // Common result processing and file writing logic
    for (const taskResult of taskResults) {
        if (!taskResult) {
            logger.warn(`A task returned no result. This should not happen.`);
            continue;
        }
        if (taskResult.type === 'success') {
            logger.info(`Data found for ${taskResult.data.url}`, { url: taskResult.data.url });
            results.push(taskResult.data);
        } else if (taskResult.type === 'no_data') {
            logger.warn('No Prebid data found for URL (summary)', { url: taskResult.url });
        } else if (taskResult.type === 'error') {
            logger.error('Error processing URL (summary)', { url: taskResult.url, error: taskResult.error });
        }
    }

    logger.info('Final Results Array Count:', { count: results.length });

    try {
        if (!fs.existsSync(options.outputDir)) {
            fs.mkdirSync(options.outputDir, { recursive: true });
        }

        if (results.length > 0) {
            const now: Date = new Date();
            const month: string = now.toLocaleString('default', { month: 'short' });
            const year: number = now.getFullYear();
            const day: string = String(now.getDate()).padStart(2, '0');
            const monthDir: string = `${options.outputDir}/${month}`;
            const dateFilename: string = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${day}.json`;

            if (!fs.existsSync(monthDir)) {
                fs.mkdirSync(monthDir, { recursive: true });
            }

            const jsonOutput: string = JSON.stringify(results, null, 2);
            fs.writeFileSync(`${monthDir}/${dateFilename}`, jsonOutput + '\n', 'utf8');
            logger.info(`Results have been written to ${monthDir}/${dateFilename}`);
        } else {
            logger.info('No results to save.');
        }

        // Update inputFile logic:
        // The inputFile is overwritten with URLs that were within the processing scope (i.e., after applying any --range)
        // but were not successfully processed. `urlsToProcess` holds the list of URLs that were candidates for processing
        // (post-range), and `processedUrls` tracks all URLs that were actually sent to a processing task (across all chunks).
        if (urlSourceType === 'InputFile' && options.inputFile) {
            const remainingUrlsInAttemptedScope: string[] = urlsToProcess.filter((url: string) => !processedUrls.has(url));
            try {
                // This correctly updates the input file based on the (potentially ranged) scope of URLs that were attempted.
                fs.writeFileSync(options.inputFile, remainingUrlsInAttemptedScope.join('\n'), 'utf8');
                logger.info(`${options.inputFile} updated. ${processedUrls.size} URLs processed from the current scope, ${remainingUrlsInAttemptedScope.length} URLs remain in current scope.`);
            } catch (writeError: any) {
                logger.error(`Failed to update ${options.inputFile}: ${writeError.message}`);
            }
        }

    } catch (err: any) {
        logger.error('Failed to write results or update input file system', { error: err });
    }
}
