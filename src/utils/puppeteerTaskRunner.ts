import type { Logger as WinstonLogger } from 'winston';
import { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import { Cluster } from 'puppeteer-cluster';
import { PrebidExplorerOptions, PageData, TaskResult } from '../prebid.js';

/**
 * @internal
 * Configures a Puppeteer page with common settings for the scan.
 * This includes setting a default timeout and a common user agent string.
 * @param page - The Puppeteer {@link Page} instance to configure.
 * @returns A promise that resolves with the configured page.
 */
async function configurePage(page: Page): Promise<Page> {
    page.setDefaultTimeout(55000); // Set a default timeout for page operations
    // Set a common user agent to avoid detection as a bot
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    return page;
}

/**
 * @internal
 * Manages the execution of Puppeteer tasks for scanning web pages.
 * This class abstracts the complexities of launching Puppeteer (either as a single
 * instance or a cluster for parallel processing), navigating to pages,
 * and extracting data. It's designed to be used by the main `prebidExplorer` function.
 */
export class PuppeteerTaskRunner {
    private logger: WinstonLogger;
    private options: PrebidExplorerOptions;
    private puppeteer: any; // Stores the puppeteer instance (could be puppeteer-extra)

    /**
     * Constructs a PuppeteerTaskRunner instance.
     * @param options - The {@link PrebidExplorerOptions} for configuring the scan,
     *                  including Puppeteer type, concurrency, and launch options.
     * @param logger - The Winston logger instance for logging messages.
     * @param puppeteer - The Puppeteer instance to use (typically `puppeteer-extra`
     *                    enhanced with plugins like stealth).
     */
    constructor(options: PrebidExplorerOptions, logger: WinstonLogger, puppeteer: any) {
        this.options = options;
        this.logger = logger;
        this.puppeteer = puppeteer;
    }

    /**
     * Processes a single webpage to extract Prebid.js and other ad library data.
     * This method navigates to the given URL, waits for network activity to settle,
     * executes a script within the page context to gather data, and then
     * categorizes the result (success, no_data, or error).
     *
     * @param page - The Puppeteer {@link Page} instance to use for navigation and data extraction.
     * @param url - The URL of the webpage to process.
     * @returns A Promise resolving to a {@link TaskResult} object representing the outcome of the scan.
     */
    private async processPageTask({ page, data: url }: { page: Page, data: string }): Promise<TaskResult> {
        const trimmedUrl: string = url; // data is the URL passed by puppeteer-cluster queue
        this.logger.info(`Processing: ${trimmedUrl}`, { url: trimmedUrl });
        try {
            await configurePage(page);
            await page.goto(trimmedUrl, { timeout: 60000, waitUntil: 'networkidle2' });

            // Wait for a fixed period to allow dynamic content to load
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
                this.logger.warn(`No relevant Prebid or ad library data found for ${trimmedUrl}`, { url: trimmedUrl });
                return { type: 'no_data', url: trimmedUrl };
            }
        } catch (pageError: any) {
            this.logger.error(`Error processing ${trimmedUrl}`, { url: trimmedUrl, error: pageError.message, stack: pageError.stack });
            const errorMessage: string = pageError.message || 'Unknown error';
            const netErrorMatch: RegExpMatchArray | null = errorMessage.match(/net::([A-Z_]+)/);
            let errorCode: string;

            if (netErrorMatch) {
                errorCode = netErrorMatch[1]; // e.g., 'ERR_NAME_NOT_RESOLVED'
            } else {
                // Extract a more generic error code if a network error is not matched
                const prefix: string = `Error processing ${trimmedUrl}: `;
                if (errorMessage.startsWith(prefix)) {
                    errorCode = errorMessage.substring(prefix.length).trim();
                } else {
                    errorCode = errorMessage.trim();
                }
                errorCode = errorCode.replace(/\s+/g, '_').toUpperCase() || 'UNKNOWN_PAGE_ERROR';
            }
            return { type: 'error', url: trimmedUrl, error: errorCode };
        }
    }

    /**
     * Orchestrates the scanning of multiple URLs, handling chunking and parallelism.
     * It uses either a vanilla Puppeteer setup or `puppeteer-cluster` based on options.
     *
     * @param urlsToProcess - An array of URL strings to be scanned.
     * @param processedUrlsSet - A Set that will be populated with URLs that have been
     *                           submitted for processing by this method. This is used
     *                           by the caller to track which URLs were attempted.
     * @returns A Promise resolving to an array of {@link TaskResult} objects,
     *          one for each processed URL.
     * @example
     * ```typescript
     * const taskRunner = new PuppeteerTaskRunner(options, logger, puppeteer);
     * const urls = ["https://example.com", "https://another.com"];
     * const attemptedUrls = new Set<string>();
     * const results = await taskRunner.runTasks(urls, attemptedUrls);
     * console.log(`Attempted to process ${attemptedUrls.size} URLs.`);
     * ```
     */
    public async runTasks(urlsToProcess: string[], processedUrlsSet: Set<string>): Promise<TaskResult[]> {
        const taskResults: TaskResult[] = [];
        const basePuppeteerOptions: PuppeteerLaunchOptions = {
            protocolTimeout: 1000000, // Increased timeout for reliability
            defaultViewport: null, // Use default viewport size
            headless: this.options.headless,
            args: this.options.puppeteerLaunchOptions?.args || [], // Pass through any custom args
            ...this.options.puppeteerLaunchOptions // Spread other launch options
        };

        const chunkSize = this.options.chunkSize && this.options.chunkSize > 0 ? this.options.chunkSize : 0;

        if (chunkSize > 0) {
            this.logger.info(`Chunked processing enabled. Chunk size: ${chunkSize}`);
            const totalChunks = Math.ceil(urlsToProcess.length / chunkSize);
            this.logger.info(`Total chunks to process: ${totalChunks}`);

            for (let i = 0; i < urlsToProcess.length; i += chunkSize) {
                const currentChunkUrls = urlsToProcess.slice(i, i + chunkSize);
                const chunkNumber = Math.floor(i / chunkSize) + 1;
                this.logger.info(`Processing chunk ${chunkNumber} of ${totalChunks}: URLs ${i + 1}-${Math.min(i + chunkSize, urlsToProcess.length)}`);

                await this.executeChunk(currentChunkUrls, basePuppeteerOptions, taskResults, processedUrlsSet, chunkNumber);
                this.logger.info(`Finished processing chunk ${chunkNumber} of ${totalChunks}.`);
            }
        } else {
            this.logger.info(`Processing all ${urlsToProcess.length} URLs without chunking.`);
            await this.executeChunk(urlsToProcess, basePuppeteerOptions, taskResults, processedUrlsSet);
        }
        return taskResults;
    }

    /**
     * Executes a single chunk of URLs using either 'cluster' or 'vanilla' Puppeteer.
     * @param urlsInChunk - Array of URLs for the current chunk.
     * @param basePuppeteerOptions - Base options for launching Puppeteer.
     * @param taskResults - Array to accumulate results.
     * @param processedUrlsSet - Set to track processed URLs.
     * @param chunkNumber - Optional chunk number for logging.
     * @private
     */
    private async executeChunk(
        urlsInChunk: string[],
        basePuppeteerOptions: PuppeteerLaunchOptions,
        taskResults: TaskResult[], // Modifies this array directly
        processedUrlsSet: Set<string>, // Modifies this set directly
        chunkNumber?: number
    ): Promise<void> {
        if (this.options.puppeteerType === 'cluster') {
            const cluster: Cluster<string, TaskResult> = await Cluster.launch({
                concurrency: Cluster.CONCURRENCY_CONTEXT,
                maxConcurrency: this.options.concurrency,
                monitor: this.options.monitor,
                puppeteer: this.puppeteer, // Use the puppeteer-extra instance
                puppeteerOptions: basePuppeteerOptions,
            });

            // Bind `this` context for processPageTask when used as a cluster task
            await cluster.task(this.processPageTask.bind(this) as any);

            try {
                const promises = urlsInChunk.filter(url => url).map(url => {
                    processedUrlsSet.add(url); // Mark as attempted
                    return cluster.queue(url)
                        .catch(error => {
                            const logContext = chunkNumber ? `in chunk ${chunkNumber}` : '';
                            this.logger.error(`Error from cluster.queue for ${url} ${logContext}:`, { error: error.message });
                            return { type: 'error', url: url, error: 'QUEUE_ERROR_OR_TASK_FAILED' } as TaskResult;
                        });
                });
                const settledResults = await Promise.allSettled(promises);
                settledResults.forEach(settledResult => {
                    if (settledResult.status === 'fulfilled') {
                        if (settledResult.value !== undefined && settledResult.value !== null) {
                            taskResults.push(settledResult.value);
                        } else {
                            const logContext = chunkNumber ? `(chunk ${chunkNumber})` : '(non-chunked)';
                            this.logger.warn(`A task from cluster.queue ${logContext} settled with undefined/null value.`, { settledResult });
                        }
                    } else { // status === 'rejected'
                        this.logger.error(`A promise from cluster.queue ${chunkNumber ? `(chunk ${chunkNumber})` : ''} settled as rejected.`, { reason: settledResult.reason });
                        // Potentially push an error TaskResult if the rejection reason can be mapped to a URL, though cluster.queue().catch() should handle this.
                    }
                });
                await cluster.idle();
                await cluster.close();
            } catch (error: any) {
                const logContext = chunkNumber ? `chunk ${chunkNumber}` : 'cluster processing';
                this.logger.error(`An error occurred during processing ${logContext} with puppeteer-cluster.`, { error: error.message, stack: error.stack });
                if (cluster) await cluster.close(); // Ensure cluster is closed on error
            }
        } else { // 'vanilla' Puppeteer
            let browser: Browser | null = null;
            try {
                browser = await this.puppeteer.launch(basePuppeteerOptions);
                if (browser) {
                    for (const url of urlsInChunk) {
                        if (url) { // Ensure URL is not empty/null
                            const page = await browser.newPage();
                            const result = await this.processPageTask({ page, data: url });
                            taskResults.push(result);
                            await page.close();
                            processedUrlsSet.add(url); // Mark as attempted
                        }
                    }
                } else {
                     this.logger.error(`Browser instance could not be launched (was null/undefined) during vanilla processing for chunk ${chunkNumber || 'N/A'}.`);
                }
            } catch (error: any) {
                const logContext = chunkNumber ? `chunk ${chunkNumber}` : 'vanilla processing';
                this.logger.error(`An error occurred during ${logContext} with vanilla Puppeteer.`, { error: error.message, stack: error.stack });
            } finally {
                if (browser) {
                    await browser.close();
                }
            }
        }
    }
}

/**
 * @internal
 * Injects the Puppeteer (puppeteer-extra) instance into this module.
 * This is called from `prebid.ts` to provide the configured Puppeteer instance
 * to the `PuppeteerTaskRunner`.
 * @param instance - The Puppeteer instance (typically `puppeteer-extra`).
 */
export function setPuppeteerInstance(instance: any) {
    // This function is a bit of a workaround for module dependencies.
    // The PuppeteerTaskRunner class uses the puppeteer instance passed to its constructor.
    // This function was likely intended to set a module-global puppeteer instance,
    // but the class correctly uses `this.puppeteer` from its constructor.
    // Thus, this function doesn't directly affect the PuppeteerTaskRunner's instance methods
    // if the runner is instantiated correctly by passing puppeteer to its constructor.
    // It's kept for now if other parts of the module might rely on it, but ideally,
    // the PuppeteerTaskRunner constructor injection is the primary mechanism.
    // puppeteerInstance = instance; // This line is commented out as the class uses constructor injection.
}
