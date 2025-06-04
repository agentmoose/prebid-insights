import { initializeLogger } from './utils/logger.js';
import type { Logger as WinstonLogger } from 'winston';
import { addExtra } from 'puppeteer-extra';
import puppeteerVanilla, { PuppeteerLaunchOptions } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import blockResourcesPluginFactory from 'puppeteer-extra-plugin-block-resources';
import { UrlProcessor } from './utils/urlProcessor.js';
import { PuppeteerTaskRunner } from './utils/puppeteerTaskRunner.js';
import { ResultsProcessor } from './utils/resultsProcessor.js';

/**
 * Represents a Prebid.js instance detected on a webpage.
 * This interface defines the structure for storing information about
 * a specific Prebid.js instance, including its global variable name,
 * version, and the list of installed modules.
 */
export interface PrebidInstance {
    /**
     * The global variable name under which the Prebid.js instance is available
     * on the page (e.g., 'pbjs', 'googletag.pbjs').
     */
    globalVarName: string;
    /**
     * The version string of the Prebid.js instance (e.g., "8.40.0").
     */
    version: string;
    /**
     * An array of strings, where each string is the name of an installed
     * Prebid.js module (e.g., "appnexusBidAdapter", "gptPreAuction").
     */
    modules: string[];
}

/**
 * Represents the structured data extracted from a scanned webpage.
 * This includes information about detected ad libraries, the scan date,
 * any Prebid.js instances found, and the URL of the page.
 */
export interface PageData {
    /**
     * An array of strings listing the names of ad-related libraries detected on
     * the page (e.g., 'apstag', 'googletag', 'ats').
     */
    libraries: string[];
    /**
     * The date of the scan in YYYY-MM-DD format.
     */
    date: string;
    /**
     * An optional array of {@link PrebidInstance} objects, present if Prebid.js
     * instances were detected on the page.
     */
    prebidInstances?: PrebidInstance[];
    /**
     * The URL of the webpage from which this data was extracted.
     */
    url?: string;
}

/**
 * Represents the result of a successful page processing task.
 * The `type` property is 'success', and it includes the extracted {@link PageData}.
 */
export interface TaskResultSuccess {
    /** Indicates a successful outcome of the page scan. */
    type: 'success';
    /** The data extracted from the page. */
    data: PageData;
}

/**
 * Represents a page processing task that found no relevant ad library data.
 * The `type` property is 'no_data', and it includes the URL of the scanned page.
 */
export interface TaskResultNoData {
    /** Indicates that no relevant ad library (including Prebid.js) data was found. */
    type: 'no_data';
    /** The URL of the scanned page. */
    url: string;
}

/**
 * Represents a page processing task that encountered an error.
 * The `type` property is 'error', and it includes the URL and an error code/message.
 */
export interface TaskResultError {
    /** Indicates an error occurred during the page scan. */
    type: 'error';
    /** The URL of the page where the error occurred. */
    url: string;
    /** A string code or message describing the error (e.g., 'TIMEOUT', 'NET_ERROR'). */
    error: string;
}

/**
 * Represents the possible outcomes of a page processing task.
 * It can be a success with data, a case where no relevant data was found,
 * or an error during processing.
 */
export type TaskResult = TaskResultSuccess | TaskResultNoData | TaskResultError;

/**
 * Defines the configuration options for the Prebid Explorer application.
 * These options control various aspects of the URL scanning process,
 * including input sources, Puppeteer behavior, and output settings.
 */
export interface PrebidExplorerOptions {
    /**
     * Optional path to a local file containing URLs to scan.
     * Supported formats: `.txt` (one URL per line), `.csv` (URLs in the first column),
     * or `.json` (extracts all string values that are valid URLs).
     * This is used if `githubRepo` is not provided.
     */
    inputFile?: string;
    /**
     * @deprecated Prefer `inputFile`. Path to a local CSV file containing URLs.
     */
    csvFile?: string;
    /**
     * Optional URL of a public GitHub repository or a direct link to a file
     * within a repository to scan for URLs. If provided, `inputFile` is ignored.
     */
    githubRepo?: string;
    /**
     * The maximum number of URLs to process when the source is a GitHub repository.
     * Defaults to 100 if not specified.
     */
    numUrls?: number;
    /**
     * Specifies the Puppeteer operational mode.
     * - `'vanilla'`: Processes URLs sequentially using a single Puppeteer browser instance.
     * - `'cluster'`: Uses `puppeteer-cluster` to process URLs in parallel. (Default)
     */
    puppeteerType: 'vanilla' | 'cluster';
    /**
     * The number of concurrent pages/browsers to use when `puppeteerType` is 'cluster'.
     * Defaults to 5.
     */
    concurrency: number;
    /**
     * Whether to run Puppeteer in headless mode (no visible UI).
     * Defaults to `true`.
     */
    headless: boolean;
    /**
     * Whether to enable the `puppeteer-cluster` web monitoring interface
     * (typically available at `http://localhost:21337`).
     * Defaults to `false`.
     */
    monitor: boolean;
    /**
     * The directory where scan results (JSON files) will be saved.
     * Results are typically saved in a subdirectory structure like `outputDir/Month/YYYY-MM-DD.json`.
     * Defaults to `'store'`.
     */
    outputDir: string;
    /**
     * The directory where log files (e.g., `app.log`, `error.log`) will be saved.
     * Defaults to `'logs'`.
     */
    logDir: string;
    /**
     * Optional additional launch options for Puppeteer, conforming to
     * Puppeteer's `PuppeteerLaunchOptions` interface.
     */
    puppeteerLaunchOptions?: PuppeteerLaunchOptions;
    /**
     * An optional string specifying a line range (e.g., "1-100", "50-", "-200")
     * to process from the input URL list. This uses 1-based indexing.
     * The range applies to the list of URLs after they have been fetched and aggregated
     * from the specified source (file or GitHub).
     */
    range?: string;
    /**
     * Optional. If specified and greater than 0, URLs will be processed in chunks of this size.
     * This processes all URLs (whether from the full input or a specified range)
     * but does so by loading and analyzing only `chunkSize` URLs at a time.
     * Useful for very large lists to manage resources or process incrementally.
     * Defaults to 0 (no chunking).
     */
    chunkSize?: number;
}

/**
 * Logger instance for the Prebid Explorer.
 * Initialized by {@link prebidExplorer}.
 * @internal
 */
let logger: WinstonLogger;

/**
 * Puppeteer instance enhanced with `puppeteer-extra` plugins.
 * This instance is configured with StealthPlugin and potentially others.
 * @internal
 */
const puppeteer = addExtra(puppeteerVanilla as any); // `as any` to accommodate puppeteer-extra's modifications


/**
 * Main orchestration function for the Prebid Integration Monitor.
 *
 * This function initializes services, fetches URLs based on the provided options,
 * processes them using Puppeteer (either in vanilla or cluster mode),
 * and then saves the extracted Prebid.js integration data.
 *
 * @param options - The {@link PrebidExplorerOptions} object that configures the scan.
 *                  This includes URL sources, Puppeteer settings, output directories, and more.
 * @returns A promise that resolves when all URLs have been processed and results saved, or void.
 * @throws Error if no URL source (inputFile or githubRepo) is specified.
 *
 * @example
 * ```typescript
 * const options: PrebidExplorerOptions = {
 *   inputFile: 'urls.txt',
 *   puppeteerType: 'cluster',
 *   concurrency: 10,
 *   headless: true,
 *   monitor: false,
 *   outputDir: 'output_results',
 *   logDir: 'scan_logs',
 *   chunkSize: 100,
 * };
 *
 * prebidExplorer(options)
 *   .then(() => console.log('Scan finished.'))
 *   .catch(error => console.error('Scan failed:', error));
 * ```
 */
export async function prebidExplorer(options: PrebidExplorerOptions): Promise<void> {
    logger = initializeLogger(options.logDir);
    // Puppeteer instance is passed directly to PuppeteerTaskRunner constructor

    // Initialize utility classes
    const urlProcessor = new UrlProcessor(logger);
    const taskRunner = new PuppeteerTaskRunner(options, logger, puppeteer);
    const resultsProcessor = new ResultsProcessor(options, logger);

    // Apply puppeteer-extra plugins
    puppeteer.use(StealthPlugin());

    const blockResources = (blockResourcesPluginFactory as any)(); // `as any` due to potential factory signature
    if (blockResources && blockResources.blockedTypes && typeof blockResources.blockedTypes.add === 'function') {
      const typesToBlock: Set<string> = new Set<string>([
          'image', 'font', 'websocket', 'media',
          'texttrack', 'eventsource', 'manifest', 'other'
      ]);
      typesToBlock.forEach(type => blockResources.blockedTypes.add(type));
      puppeteer.use(blockResources);
    } else {
      logger.warn('Could not configure blockResourcesPlugin: blockedTypes property or .add method not available on instance.', { plugin: blockResources });
    }

    let allUrls: string[] = [];
    let urlSourceType = ''; // To track the source for logging and input file updates
    const processedUrls = new Set<string>(); // Keep track of URLs actually sent to tasks

    // 1. Fetch URLs using UrlProcessor
    if (options.githubRepo) {
        urlSourceType = 'GitHub';
        allUrls = await urlProcessor.fetchUrlsFromGitHub(options.githubRepo, options.numUrls);
        if (allUrls.length > 0) {
            logger.info(`Successfully loaded ${allUrls.length} URLs from GitHub repository: ${options.githubRepo}`);
        } else {
            logger.warn(`No URLs found or fetched from GitHub repository: ${options.githubRepo}.`);
        }
    } else if (options.inputFile) {
        urlSourceType = 'InputFile';
        const fileContent = urlProcessor.loadFileContents(options.inputFile);
        if (fileContent) {
            const fileType = options.inputFile.substring(options.inputFile.lastIndexOf('.') + 1) || 'unknown';
            logger.info(`Processing local file: ${options.inputFile} (detected type: ${fileType})`);
            allUrls = await urlProcessor.processFileContent(options.inputFile, fileContent);
            if (allUrls.length > 0) {
                logger.info(`Successfully loaded ${allUrls.length} URLs from local ${fileType.toUpperCase()} file: ${options.inputFile}`);
            } else {
                logger.warn(`No URLs extracted from local ${fileType.toUpperCase()} file: ${options.inputFile}.`);
            }
        } else {
            allUrls = []; // Ensure allUrls is empty if file read failed
            logger.error(`Failed to load content from input file ${options.inputFile}. Cannot proceed with this source.`);
        }
    } else {
        logger.error('No URL source provided. Either --githubRepo or inputFile argument must be specified.');
        throw new Error('No URL source specified.'); // Critical error, execution should stop.
    }

    if (allUrls.length === 0) {
        logger.warn(`No URLs to process from ${urlSourceType || 'any specified source'}. Exiting.`);
        return;
    }
    logger.info(`Initial total URLs found: ${allUrls.length}`, { firstFew: allUrls.slice(0, 5) });

    // 2. Apply Range Logic (if any) to the fetched URLs
    if (options.range) {
        logger.info(`Applying range: ${options.range}`);
        const originalUrlCount = allUrls.length;
        let [startStr, endStr] = options.range.split('-');
        // Default to 1 if start is empty, default to list length if end is empty
        let start = startStr ? parseInt(startStr, 10) : 1;
        let end = endStr ? parseInt(endStr, 10) : allUrls.length;

        if (isNaN(start) || isNaN(end) || start < 0 || end < 0) {
            logger.warn(`Invalid range format: "${options.range}". Proceeding with all URLs. Start and end must be positive numbers. User input is 1-based.`);
        } else {
            // Convert 1-based to 0-based indices for slice
            start = start > 0 ? start - 1 : 0;
            // end is exclusive for slice, so if user means "up to 100", it's index 99, slice(0, 100)
            end = end > 0 ? end : allUrls.length;

            if (start >= allUrls.length) {
                logger.warn(`Start of range (${start + 1}) is beyond the total number of URLs (${allUrls.length}). No URLs to process.`);
                allUrls = [];
            } else if (start >= end) { // If start is same or greater than end (after 0-based conversion)
                 logger.warn(`Start of range (${start + 1}) is not before end of range (${end}). Processing URLs from start index ${start} to end of list.`);
                 allUrls = allUrls.slice(start);
            } else {
                allUrls = allUrls.slice(start, end);
                logger.info(`Applied range: Processing URLs from original index ${start + 1} to ${Math.min(end, originalUrlCount)}. Total URLs after range: ${allUrls.length}`);
            }
        }
    }

    if (allUrls.length === 0) {
        logger.warn(`No URLs to process after applying range or due to empty initial list. Exiting.`);
        return;
    }
    logger.info(`Total URLs to process after range check: ${allUrls.length}`, { firstFew: allUrls.slice(0, 5) });

    const urlsToProcess = allUrls; // This is the final list of URLs to be processed (potentially ranged)

    // 3. Run Puppeteer tasks using PuppeteerTaskRunner
    // The `processedUrls` set will be populated by the taskRunner with URLs it actually attempts
    const taskResults: TaskResult[] = await taskRunner.runTasks(urlsToProcess, processedUrls);

    // 4. Process and save results using ResultsProcessor
    // urlsToProcess is passed here to correctly update the input file based on the *scoped* list
    resultsProcessor.saveResults(taskResults, processedUrls, urlsToProcess, urlSourceType);

    logger.info('Prebid Explorer run completed.');
}
