/**
 * @fileoverview This module is responsible for handling the outcomes of page processing tasks.
 * It includes functions for logging different task results (success, no data, error),
 * aggregating successful data, writing these results to JSON files in an organized
 * directory structure, and updating input files (e.g., removing successfully processed URLs).
 */

import * as fs from 'fs';
import * as path from 'path'; // Import path module for robust file path operations
import type { Logger as WinstonLogger } from 'winston';
// Import shared types from the new common location
import type { TaskResult, PageData } from '../common/types.js';

/**
 * Processes an array of {@link TaskResult} objects. It logs the outcome of each task
 * (success, no data, or error) using the provided logger and aggregates all {@link PageData}
 * from tasks that were successfully processed.
 *
 * For tasks of type 'error', it logs the structured {@link ErrorDetails} including
 * `code`, `message`, and potentially `stack`.
 *
 * @param {TaskResult[]} taskResults - An array of task results. Each element is an object
 *                                     conforming to the `TaskResult` discriminated union
 *                                     (i.e., {@link TaskResultSuccess}, {@link TaskResultNoData}, or {@link TaskResultError}).
 * @param {WinstonLogger} logger - An instance of WinstonLogger for logging messages.
 * @returns {PageData[]} An array containing only the `PageData` objects from successful tasks.
 *                       Returns an empty array if no tasks were successful or if the input `taskResults` is empty.
 * @example
 * const results = [
 *   { type: 'success', data: { url: 'https://a.com', libraries: ['libA'], date: '2023-01-01', prebidInstances: [] } },
 *   { type: 'no_data', url: 'https://b.com' },
 *   { type: 'error', url: 'https://c.com', error: { code: 'TIMEOUT', message: 'Page timed out' } }
 * ];
 * const successfulData = processAndLogTaskResults(results, logger);
 * // successfulData would be [{ url: 'https://a.com', libraries: ['libA'], date: '2023-01-01', prebidInstances: [] }]
 * // The logger would have recorded:
 * // - An info message for 'https://a.com'.
 * // - A warning for 'https://b.com'.
 * // - An error message for 'https://c.com', including its error code and message.
 */
export function processAndLogTaskResults(
  taskResults: TaskResult[],
  logger: WinstonLogger,
  errorOutputDir: string = 'errors' // Default error output directory
): PageData[] {
  const successfulResults: PageData[] = [];
  if (!taskResults || taskResults.length === 0) {
    logger.info('No task results to process.');
    return successfulResults;
  }

  logger.info(`Processing ${taskResults.length} task results...`);
  for (const taskResult of taskResults) {
    if (!taskResult) {
      logger.warn(
        `A task returned no result or an undefined entry in taskResults. This should ideally not happen.`
      );
      continue;
    }

    // Use type property to discriminate and log accordingly
    const { type } = taskResult;
    switch (type) {
      case 'success':
        logger.info(`SUCCESS: Data extracted for ${taskResult.data.url}`, {
          url: taskResult.data.url,
          version: taskResult.data.prebidInstances?.[0]?.version, // Log first Prebid instance version if available
        });
        successfulResults.push(taskResult.data);
        break;
      case 'no_data':
        logger.warn(
          `NO_DATA: No relevant ad tech data found for ${taskResult.url}`,
          { url: taskResult.url }
        );
        logErrorUrl(taskResult.url, 'no_prebid', errorOutputDir, logger);
        break;
      case 'error':
        // Log structured error details
        logger.error(
          `ERROR: Processing failed for ${taskResult.url} - Code: ${taskResult.error.code}, Msg: ${taskResult.error.message}`,
          { url: taskResult.url, errorDetails: taskResult.error } // errorDetails will contain code, message, and stack
        );
        // Determine error type for logging
        const errorCode = taskResult.error.code?.toUpperCase();
        const errorMessage = taskResult.error.message?.toLowerCase() || '';
        let errorTypeForFile: ErrorType = 'processing_error'; // Default to processing_error

        if (
          errorCode === 'ENOTFOUND' ||
          errorCode === 'ERR_NAME_NOT_RESOLVED' ||
          errorMessage.includes('navigation timeout') ||
          errorMessage.includes('net::err_name_not_resolved') ||
          errorMessage.includes('net::err_connection_refused') ||
          errorMessage.includes('net::err_timed_out') ||
          errorMessage.includes('timeout') // A more generic timeout check
        ) {
          errorTypeForFile = 'navigation_error';
        }
        logErrorUrl(taskResult.url, errorTypeForFile, errorOutputDir, logger);
        break;
      default:
        // This path should ideally be unreachable if 'type' is always a valid TaskResultType.
        const exhaustiveCheck: never = type; // TypeScript will error here if any TaskResultType is unhandled
        logger.warn(
          `Unknown task result type encountered: '${exhaustiveCheck}'`,
          { result: taskResult }
        );
    }
  }
  logger.info(
    `Finished processing task results. ${successfulResults.length} successful extractions.`
  );
  return successfulResults;
}

/**
 * Writes an array of {@link PageData} objects to a JSON file.
 * The file is organized into a directory structure based on the current year and month,
 * and the filename includes the current date (e.g., `<outputDir>/<YYYY-MM-Mon>/<YYYY-MM-DD>.json`).
 * If the target directory (including year-month subdirectory) does not exist, it will be created.
 *
 * @param {PageData[]} resultsToSave - An array of `PageData` objects to be written to the file.
 *                                     If empty or undefined, the function logs this and returns without writing.
 * @param {string} baseOutputDir - The root directory where the dated subdirectories and result files will be created.
 * @param {WinstonLogger} logger - An instance of WinstonLogger for logging messages, including success or failure of file operations.
 * @example
 * const dataToSave = [{ url: 'https://a.com', libraries: [], date: '2023-01-01', prebidInstances: [] }];
 * writeResultsToFile(dataToSave, "/app/output", logger);
 * // This might create a file like /app/output/2023-01-Jan/2023-01-15.json (assuming current date is Jan 15, 2023)
 */
export function writeResultsToFile(
  resultsToSave: PageData[],
  baseOutputDir: string,
  logger: WinstonLogger
): void {
  if (!resultsToSave || resultsToSave.length === 0) {
    logger.info('No results to save to file.');
    return;
  }

  try {
    const now = new Date();
    const year = now.getFullYear().toString();
    const monthPadded = String(now.getMonth() + 1).padStart(2, '0');
    const monthShort = now.toLocaleString('default', { month: 'short' });
    const dayPadded = String(now.getDate()).padStart(2, '0');

    // New directory structure: store/<Mmm-yyyy>/<yyyy-mm-dd>.json
    const monthYearDir = path.join(baseOutputDir, `${monthShort}-${year}`);
    const fullPathDir = path.join(
      monthYearDir,
      `${year}-${monthPadded}-${dayPadded}.json`
    );

    // Ensure all necessary directories are created
    const dirName = path.dirname(fullPathDir);
    if (!fs.existsSync(dirName)) {
      fs.mkdirSync(dirName, { recursive: true });
      logger.info(`Created output directory: ${dirName}`);
    }

    let finalResults = resultsToSave;

    if (fs.existsSync(fullPathDir)) {
      try {
        const existingContent = fs.readFileSync(fullPathDir, 'utf8');
        const existingData = JSON.parse(existingContent);
        if (Array.isArray(existingData)) {
          finalResults = [...existingData, ...resultsToSave];
          logger.info(
            `Appending ${resultsToSave.length} new results to existing file ${fullPathDir}. Total: ${finalResults.length}`
          );
        } else {
          logger.warn(
            `Existing file ${fullPathDir} is not valid JSON array. Overwriting with new results.`
          );
        }
      } catch (readError: any) {
        logger.warn(
          `Error reading or parsing existing file ${fullPathDir}: ${readError.message}. Overwriting with new results.`
        );
      }
    } else {
      logger.info(
        `Creating new file ${fullPathDir} with ${resultsToSave.length} results.`
      );
    }

    const jsonOutput = JSON.stringify(finalResults, null, 2);
    fs.writeFileSync(fullPathDir, jsonOutput + '\n', 'utf8');
    logger.info(
      `Successfully wrote ${finalResults.length} results to ${fullPathDir}`
    );
  } catch (e: unknown) {
    const err = e as Error; // Cast to Error for standard properties
    logger.error('Failed to write results to file system.', {
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack, // Include stack trace for debugging
    });
    // Note: This function currently does not re-throw the error.
    // The caller (e.g., prebidExplorer) will continue, potentially without saved results for this batch.
  }
}

/**
 * Updates a specified input file (expected to be a `.txt` file containing a list of URLs, one per line)
 * by removing URLs that were successfully processed in the current run.
 *
 * The logic is as follows:
 * 1. Reads all URLs from the existing `inputFilepath`.
 * 2. Identifies successfully processed URLs from the `taskResults`.
 * 3. Filters the original list of URLs:
 *    - URLs not part of the `urlsInCurrentProcessingScope` are always kept (preserved).
 *    - URLs that were part of `urlsInCurrentProcessingScope` are kept only if they were *not* successfully processed.
 * 4. The resulting list of URLs (those to be kept/retried) is written back to `inputFilepath`, overwriting it.
 *
 * If `inputFilepath` does not exist, a warning is logged, and a new file is created containing only
 * the URLs from `urlsInCurrentProcessingScope` that were not successfully processed.
 * If `inputFilepath` is not a `.txt` file, the operation is skipped.
 *
 * @param {string} inputFilepath - The path to the input file (e.g., "urls_to_scan.txt").
 * @param {string[]} urlsInCurrentProcessingScope - An array of all URLs that were candidates for processing
 *                                                  in the current execution batch (e.g., after applying range or chunking filters).
 * @param {TaskResult[]} taskResults - An array of {@link TaskResult} objects representing the outcomes
 *                                     for the URLs that were attempted in the current scope.
 * @param {WinstonLogger} logger - An instance of WinstonLogger for logging messages.
 * @example
 * // Assume "pending.txt" originally contains:
 * // https://a.com
 * // https://b.com
 * // https://c.com
 * // https://d.com (this one was not in current scope for this example run)
 *
 * const currentScopeForRun = ["https://a.com", "https://b.com", "https://c.com"];
 * const outcomesForRun = [
 *   { type: 'success', data: { url: 'https://a.com', ... } },
 *   { type: 'error', url: 'https://b.com', error: { code: 'TIMEOUT', message: 'Page timed out' } },
 *   { type: 'success', data: { url: 'https://c.com', ... } }
 * ];
 *
 * updateInputFile("pending.txt", currentScopeForRun, outcomesForRun, logger);
 *
 * // "pending.txt" will be updated to contain:
 * // https://b.com  (kept because it was in scope but failed)
 * // https://d.com  (kept because it was not in the current processing scope)
 */
export function updateInputFile(
  inputFilepath: string,
  urlsInCurrentProcessingScope: string[],
  taskResults: TaskResult[],
  logger: WinstonLogger
): void {
  if (!inputFilepath.endsWith('.txt')) {
    logger.info(
      `Skipping modification of input file as it is not a .txt file: ${inputFilepath}`
    );
    return;
  }

  try {
    const successfullyProcessedUrlsInScope = new Set<string>();
    for (const taskResult of taskResults) {
      // Only consider successful results for URLs that were actually part of the current scope
      if (
        taskResult &&
        taskResult.type === 'success' &&
        taskResult.data.url &&
        urlsInCurrentProcessingScope.includes(taskResult.data.url)
      ) {
        successfullyProcessedUrlsInScope.add(taskResult.data.url);
      }
    }

    let finalUrlsToWrite: string[];

    if (fs.existsSync(inputFilepath)) {
      const originalContent = fs.readFileSync(inputFilepath, 'utf8');
      const originalUrls = originalContent
        .split('\n')
        .map((line) => line.trim()) // Trim each line
        .filter((line) => line !== ''); // Filter out empty lines after trimming

      const currentScopeSet = new Set(
        urlsInCurrentProcessingScope.map((url) => url.trim())
      );

      finalUrlsToWrite = originalUrls.filter((url) => {
        const trimmedUrl = url.trim(); // Ensure comparison is with trimmed URLs
        if (currentScopeSet.has(trimmedUrl)) {
          // If URL was in current scope, keep it only if it was NOT successfully processed
          return !successfullyProcessedUrlsInScope.has(trimmedUrl);
        }
        return true; // Keep if not in current scope (preserve other URLs)
      });
    } else {
      // If the input file doesn't exist, new file will contain only unsuccessful URLs from current scope
      logger.warn(
        `Input file ${inputFilepath} not found for updating. Will create it with remaining (unsuccessful or unprocessed) URLs from current scope.`
      );
      finalUrlsToWrite = urlsInCurrentProcessingScope.filter(
        (url: string) => !successfullyProcessedUrlsInScope.has(url.trim())
      );
    }

    fs.writeFileSync(
      inputFilepath,
      finalUrlsToWrite.join('\n') + (finalUrlsToWrite.length > 0 ? '\n' : ''), // Add trailing newline if not empty
      'utf8'
    );
    logger.info(
      `${inputFilepath} updated. ${successfullyProcessedUrlsInScope.size} URLs from current scope successfully processed and removed. ${finalUrlsToWrite.length} URLs remain or were added.`
    );
  } catch (e: unknown) {
    const writeError = e as Error;
    logger.error(`Failed to update ${inputFilepath}: ${writeError.message}`, {
      stack: writeError.stack,
    });
  }
}

/**
 * Defines the types of errors that can be logged.
 */
export type ErrorType = 'no_prebid' | 'navigation_error' | 'processing_error';

/**
 * Logs a URL to a specific error file based on the error type.
 *
 * @param {string} url - The URL to log.
 * @param {ErrorType} errorType - The type of error.
 * @param {string} baseOutputDir - The base directory for error files (e.g., 'errors').
 * @param {WinstonLogger} logger - An instance of WinstonLogger.
 */
export function logErrorUrl(
  url: string,
  errorType: ErrorType,
  baseOutputDir: string,
  logger: WinstonLogger
): void {
  try {
    if (!fs.existsSync(baseOutputDir)) {
      fs.mkdirSync(baseOutputDir, { recursive: true });
      logger.info(`Created error output directory: ${baseOutputDir}`);
    }

    let errorFileName: string;
    switch (errorType) {
      case 'no_prebid':
        errorFileName = 'no_prebid.txt';
        break;
      case 'navigation_error':
        errorFileName = 'navigation_errors.txt';
        break;
      case 'processing_error':
        errorFileName = 'error_processing.txt';
        break;
      default:
        // Should not happen with ErrorType
        logger.warn(`Unknown error type: ${errorType}`);
        return;
    }

    const filePath = path.join(baseOutputDir, errorFileName);
    fs.appendFileSync(filePath, `${url}\n`, 'utf8');
    logger.info(
      `Logged URL ${url} to ${filePath} for error type ${errorType}.`
    );
  } catch (e: unknown) {
    const err = e as Error;
    logger.error(
      `Failed to log URL ${url} for error type ${errorType} to file.`,
      {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      }
    );
  }
}
