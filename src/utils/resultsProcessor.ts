import * as fs from 'fs';
import type { Logger as WinstonLogger } from 'winston';
import { PrebidExplorerOptions, PageData, TaskResult } from '../prebid.js';

/**
 * @internal
 * Utility class responsible for processing the results of website scans,
 * logging outcomes, and saving the extracted data. It handles the
 * aggregation of successful data, error reporting, and updating input
 * files based on processing status.
 */
export class ResultsProcessor {
    private logger: WinstonLogger;
    private options: PrebidExplorerOptions;

    /**
     * Constructs an instance of the ResultsProcessor.
     * @param options - The {@link PrebidExplorerOptions} to configure its behavior, primarily output directory.
     * @param logger - The Winston logger instance for logging messages.
     */
    constructor(options: PrebidExplorerOptions, logger: WinstonLogger) {
        this.options = options;
        this.logger = logger;
    }

    /**
     * Processes an array of task results from website scans. It filters successful
     * results, logs information about each task's outcome, and saves the
     * successfully extracted {@link PageData} to a JSON file.
     * Optionally, if the input source was a `.txt` file, it updates the file by
     * removing URLs that were part of the processing scope.
     *
     * @param taskResults - An array of {@link TaskResult} objects, each representing the outcome of a single URL scan.
     * @param processedUrls - A Set of URLs that were actually submitted for processing. This is used to determine
     *                       which URLs from the original list (after potential range filtering) should be
     *                       considered for removal from the input file if it's a `.txt` file.
     * @param urlsToProcess - An array of all URLs that were initially slated for processing (after any
     *                       range filtering was applied, but before chunking). This list is used as the
     *                       basis for determining which URLs to rewrite back to the input file.
     * @param urlSourceType - A string indicating the source of the URLs (e.g., 'InputFile', 'GitHub'),
     *                       which influences whether the input file update logic is applied.
     * @returns An array of {@link PageData} objects for all successfully processed URLs.
     * @example
     * ```typescript
     * // Assuming taskRunner.runTasks() and other necessary setup:
     * const resultsProcessor = new ResultsProcessor(options, logger);
     * const successfulPageData = resultsProcessor.saveResults(
     *   taskOutcomes,
     *   attemptedUrlsSet,
     *   originalScopedUrls,
     *   'InputFile'
     * );
     * console.log(`Successfully processed ${successfulPageData.length} pages.`);
     * ```
     */
    public saveResults(
        taskResults: TaskResult[],
        processedUrls: Set<string>,
        urlsToProcess: string[],
        urlSourceType: string
    ): PageData[] {
        const finalResults: PageData[] = [];

        for (const taskResult of taskResults) {
            if (!taskResult) {
                this.logger.warn(`A task returned no result. This should not happen.`);
                continue;
            }
            // TODO: Enhance logging with more structured data if needed
            if (taskResult.type === 'success') {
                this.logger.info(`Data found for ${taskResult.data.url}`, { url: taskResult.data.url });
                finalResults.push(taskResult.data);
            } else if (taskResult.type === 'no_data') {
                this.logger.warn('No Prebid data found for URL (summary)', { url: taskResult.url });
            } else if (taskResult.type === 'error') {
                this.logger.error('Error processing URL (summary)', { url: taskResult.url, error: taskResult.error });
            }
        }

        this.logger.info('Final Results Array Count:', { count: finalResults.length });

        try {
            // Ensure output directory exists
            if (!fs.existsSync(this.options.outputDir)) {
                fs.mkdirSync(this.options.outputDir, { recursive: true });
                this.logger.info(`Created output directory: ${this.options.outputDir}`);
            }

            if (finalResults.length > 0) {
                const now: Date = new Date();
                const month: string = now.toLocaleString('default', { month: 'short' });
                const year: number = now.getFullYear();
                const day: string = String(now.getDate()).padStart(2, '0');
                const monthDir: string = `${this.options.outputDir}/${month}`;
                const dateFilename: string = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${day}.json`;

                // Ensure month-specific directory exists
                if (!fs.existsSync(monthDir)) {
                    fs.mkdirSync(monthDir, { recursive: true });
                    this.logger.info(`Created month-specific output directory: ${monthDir}`);
                }

                const jsonOutput: string = JSON.stringify(finalResults, null, 2);
                fs.writeFileSync(`${monthDir}/${dateFilename}`, jsonOutput + '\n', 'utf8');
                this.logger.info(`Results have been written to ${monthDir}/${dateFilename}`);
            } else {
                this.logger.info('No results to save.');
            }

            // Update input .txt file if it was the source
            if (urlSourceType === 'InputFile' && this.options.inputFile && this.options.inputFile.endsWith('.txt')) {
                // urlsToProcess contains the list of URLs *after* any range was applied.
                // We filter this list to keep only URLs that were *not* successfully processed.
                const successfullyProcessedUrls: Set<string> = new Set();
                 for (const taskResult of taskResults) {
                     if (taskResult && taskResult.type === 'success' && taskResult.data.url) {
                         successfullyProcessedUrls.add(taskResult.data.url);
                     }
                 }
                const remainingUrlsInScope: string[] = urlsToProcess.filter((url: string) => !successfullyProcessedUrls.has(url));

                try {
                    fs.writeFileSync(this.options.inputFile, remainingUrlsInScope.join('\n'), 'utf8');
                    this.logger.info(`${this.options.inputFile} updated. ${successfullyProcessedUrls.size} URLs successfully processed and removed. ${remainingUrlsInScope.length} URLs remain.`);
                } catch (writeError: any) {
                    this.logger.error(`Failed to update ${this.options.inputFile}: ${writeError.message}`);
                }
            } else if (urlSourceType === 'InputFile' && this.options.inputFile) {
                this.logger.info(`Skipping modification of original ${this.options.inputFile.endsWith('.csv') ? 'CSV' : 'JSON'} input file: ${this.options.inputFile}`);
            }
        } catch (err: any) {
            this.logger.error('Failed to write results or update input file system', { error: err.message, stack: err.stack });
        }
        return finalResults;
    }
}
