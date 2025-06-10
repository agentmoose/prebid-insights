// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import type { Logger as WinstonLogger } from 'winston';
import {
  writeResultsToFile,
  processAndLogTaskResults,
  logErrorUrl,
  // ErrorType, // Removed as it's unused in this test file
} from '../results-handler';
import type { PageData, TaskResult, TaskResultError } from '../../common/types';

// Mock the 'fs' module
vi.mock('fs');

// Mock WinstonLogger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as WinstonLogger;

describe('results-handler', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    // Set a fixed date for consistent testing
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 3, 18)); // April 18, 2025
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('writeResultsToFile', () => {
    const samplePageData: PageData[] = [
      {
        url: 'http://test.com',
        libraries: [],
        date: '2025-04-18',
        prebidInstances: [],
      },
    ];
    const baseOutputDir = 'store';
    const expectedMonthYearDir = `${baseOutputDir}/Apr-2025`;
    const expectedFilePath = `${expectedMonthYearDir}/2025-04-18.json`;

    it('should create a new file if one does not exist', () => {
      (fs.existsSync as vi.Mock).mockReturnValue(false);

      writeResultsToFile(samplePageData, baseOutputDir, mockLogger);

      expect(fs.mkdirSync).toHaveBeenCalledWith(expectedMonthYearDir, {
        recursive: true,
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedFilePath,
        JSON.stringify(samplePageData, null, 2) + '\n',
        'utf8'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Created output directory: ${expectedMonthYearDir}`
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Successfully wrote 1 results to ${expectedFilePath}`
      );
    });

    it('should append to an existing file if it is a valid JSON array', () => {
      const existingData: PageData[] = [
        {
          url: 'http://old.com',
          libraries: [],
          date: '2025-04-18',
          prebidInstances: [],
        },
      ];
      (fs.existsSync as vi.Mock).mockReturnValue(true); // Both dir and file exist
      (fs.readFileSync as vi.Mock).mockReturnValue(
        JSON.stringify(existingData)
      );

      writeResultsToFile(samplePageData, baseOutputDir, mockLogger);

      expect(fs.readFileSync).toHaveBeenCalledWith(expectedFilePath, 'utf8');
      const combinedData = [...existingData, ...samplePageData];
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedFilePath,
        JSON.stringify(combinedData, null, 2) + '\n',
        'utf8'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Appending 1 new results to existing file ${expectedFilePath}. Total: 2`
      );
    });

    it('should overwrite if existing file is not a valid JSON', () => {
      (fs.existsSync as vi.Mock).mockReturnValue(true);
      (fs.readFileSync as vi.Mock).mockReturnValue('invalid json');

      writeResultsToFile(samplePageData, baseOutputDir, mockLogger);

      expect(fs.readFileSync).toHaveBeenCalledWith(expectedFilePath, 'utf8');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedFilePath,
        JSON.stringify(samplePageData, null, 2) + '\n',
        'utf8'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Error reading or parsing existing file ${expectedFilePath}: Unexpected token i in JSON at position 0. Overwriting with new results.`
        )
      );
    });

    it('should overwrite if existing file content is not an array', () => {
      (fs.existsSync as vi.Mock).mockReturnValue(true);
      (fs.readFileSync as vi.Mock).mockReturnValue(
        JSON.stringify({ data: 'not an array' })
      );

      writeResultsToFile(samplePageData, baseOutputDir, mockLogger);

      expect(fs.readFileSync).toHaveBeenCalledWith(expectedFilePath, 'utf8');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedFilePath,
        JSON.stringify(samplePageData, null, 2) + '\n',
        'utf8'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Existing file ${expectedFilePath} is not valid JSON array. Overwriting with new results.`
      );
    });

    it('should log and do nothing if there are no results to save', () => {
      writeResultsToFile([], baseOutputDir, mockLogger);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'No results to save to file.'
      );
    });

    it('should log an error if filesystem operation fails', () => {
      (fs.existsSync as vi.Mock).mockReturnValue(false);
      const writeError = new Error('Disk full');
      (fs.writeFileSync as vi.Mock).mockImplementation(() => {
        throw writeError;
      });

      writeResultsToFile(samplePageData, baseOutputDir, mockLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to write results to file system.',
        expect.objectContaining({
          errorName: writeError.name,
          errorMessage: writeError.message,
        })
      );
    });
  });

  describe('logErrorUrl and processAndLogTaskResults integration', () => {
    const errorBaseDir = 'errors';

    it('should log "no_prebid" errors via processAndLogTaskResults', () => {
      const taskResults: TaskResult[] = [
        { type: 'no_data', url: 'http://noprebid.com' },
      ];
      processAndLogTaskResults(taskResults, mockLogger, errorBaseDir);

      expect(fs.mkdirSync).toHaveBeenCalledWith(errorBaseDir, {
        recursive: true,
      });
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        `${errorBaseDir}/no_prebid.txt`,
        'http://noprebid.com\n',
        'utf8'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Logged URL http://noprebid.com to ${errorBaseDir}/no_prebid.txt for error type no_prebid.`
      );
    });

    it('should log "navigation_error" via processAndLogTaskResults for ENOTFOUND', () => {
      const taskResults: TaskResult[] = [
        {
          type: 'error',
          url: 'http://navfail.com',
          error: {
            code: 'ENOTFOUND',
            message: 'DNS lookup failed',
          } as TaskResultError['error'],
        },
      ];
      processAndLogTaskResults(taskResults, mockLogger, errorBaseDir);
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        `${errorBaseDir}/navigation_errors.txt`,
        'http://navfail.com\n',
        'utf8'
      );
    });

    it('should log "navigation_error" via processAndLogTaskResults for navigation timeout message', () => {
      const taskResults: TaskResult[] = [
        {
          type: 'error',
          url: 'http://navtimeout.com',
          error: {
            message: 'Navigation timeout exceeded',
          } as TaskResultError['error'],
        },
      ];
      processAndLogTaskResults(taskResults, mockLogger, errorBaseDir);
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        `${errorBaseDir}/navigation_errors.txt`,
        'http://navtimeout.com\n',
        'utf8'
      );
    });

    it('should log "processing_error" via processAndLogTaskResults for other errors', () => {
      const taskResults: TaskResult[] = [
        {
          type: 'error',
          url: 'http://processfail.com',
          error: {
            code: 'SOME_OTHER_ERROR',
            message: 'Something went wrong',
          } as TaskResultError['error'],
        },
      ];
      processAndLogTaskResults(taskResults, mockLogger, errorBaseDir);
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        `${errorBaseDir}/error_processing.txt`,
        'http://processfail.com\n',
        'utf8'
      );
    });

    it('should handle error during fs.appendFileSync in logErrorUrl', () => {
      const appendError = new Error('Cannot append');
      (fs.appendFileSync as vi.Mock).mockImplementation(() => {
        throw appendError;
      });

      logErrorUrl('http://anyurl.com', 'no_prebid', errorBaseDir, mockLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to log URL http://anyurl.com for error type no_prebid to file.',
        expect.objectContaining({
          errorName: appendError.name,
          errorMessage: appendError.message,
        })
      );
    });

    it('logErrorUrl creates directory if it does not exist', () => {
      (fs.existsSync as vi.Mock).mockReturnValue(false); // Mock directory does not exist
      logErrorUrl('http://test.com', 'no_prebid', errorBaseDir, mockLogger);
      expect(fs.mkdirSync).toHaveBeenCalledWith(errorBaseDir, {
        recursive: true,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        `Created error output directory: ${errorBaseDir}`
      );
    });
  });
});
