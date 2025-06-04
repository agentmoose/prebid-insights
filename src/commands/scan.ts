import {Args, Command, Flags} from '@oclif/core';
import { prebidExplorer, PrebidExplorerOptions } from '../prebid.js';

/**
 * Defines the 'scan' command for the Prebid Integration Monitor CLI.
 * This command is responsible for scanning websites for Prebid.js integrations
 * and other ad technology libraries. It gathers URLs from various sources
 * (local files or GitHub repositories), processes them using Puppeteer,
 * and saves the findings.
 *
 * @example
 * ```shell
 * # Scan URLs from a local text file with cluster mode and 10 concurrent workers
 * npx app scan websites.txt --puppeteerType=cluster --concurrency=10
 *
 * # Scan up to 50 URLs from a GitHub repository
 * npx app scan --githubRepo https://github.com/user/repo --numUrls 50
 *
 * # Run in development
 * npm run dev scan -- --githubRepo https://github.com/owner/repo
 *
 * # Run in production (after build)
 * npm run scan -- --githubRepo https://github.com/owner/repo
 * ```
 */
export default class Scan extends Command {
  /**
   * Defines the arguments for the scan command.
   * Currently, it accepts an optional `inputFile` argument.
   */
  static override args = {
    inputFile: Args.string({
      description: 'Path to a local input file containing URLs. Accepts .txt (one URL per line), .csv (URLs in the first column), or .json (extracts all string values that are valid URLs). Defaults to \'src/input.txt\' if no other source is specified.',
      required: false,
      default: 'src/input.txt',
    }),
  };

  /**
   * A brief description of what the 'scan' command does.
   * This is used by oclif to generate help text.
   */
  static override description = 'Scans websites for Prebid.js integrations. InputFile can be .txt, .csv, or .json.';

  /**
   * Example usages of the 'scan' command.
   * These are displayed in the help output.
   */
  static override examples = [
    '<%= config.bin %> <%= command.id %> websites.txt --puppeteerType=cluster --concurrency=10',
    '<%= config.bin %> <%= command.id %> --githubRepo https://github.com/user/repo --numUrls 50',
  ];

  /**
   * Defines the flags (options) available for the 'scan' command.
   * These flags allow customization of the scanning behavior, such as input sources,
   * Puppeteer settings, and output directories.
   */
  static override flags = {
    githubRepo: Flags.string({
      description: 'GitHub repository URL (e.g., https://github.com/owner/repo) or a direct link to a processable file in a repository from which to fetch URLs. If provided, `inputFile` argument is ignored.',
      required: false,
    }),
    numUrls: Flags.integer({
      description: 'Maximum number of URLs to load from the GitHub repository. Used only if --githubRepo is specified.',
      default: 100,
      required: false,
    }),
    puppeteerType: Flags.string({
      description: "Type of Puppeteer setup to use: 'vanilla' for a single browser instance, or 'cluster' for multiple concurrent instances.",
      options: ['vanilla', 'cluster'],
      default: 'cluster',
    }),
    concurrency: Flags.integer({
      description: "Number of concurrent Puppeteer instances to use when puppeteerType is 'cluster'.",
      default: 5,
    }),
    headless: Flags.boolean({
      description: 'Run Puppeteer in headless mode (no visible browser UI). Use --no-headless to run with UI.',
      default: true,
      allowNo: true,
    }),
    monitor: Flags.boolean({
      description: "Enable puppeteer-cluster's web monitoring interface (typically http://localhost:21337) when puppeteerType is 'cluster'.",
      default: false,
    }),
    outputDir: Flags.string({
      description: 'Directory to save scan results (JSON files). Results are typically saved in outputDir/Month/YYYY-MM-DD.json.',
      default: 'store', // Changed from 'output' to 'store' to match PR diff for typedoc.json
    }),
    logDir: Flags.string({
      description: 'Directory to save log files (app.log, error.log).',
      default: 'logs',
    }),
    range: Flags.string({
      description: "Specify a 1-based line range (e.g., '10-20', '5-', '-15') to process from the input URL list. Applies after URLs are fetched.",
      required: false
    }),
    chunkSize: Flags.integer({
      description: "Process URLs in chunks of this size. Processes all URLs in the specified range or input, but one chunk at a time. '0' means no chunking.",
      required: false
    }),
  };

  /**
   * Executes the scan command.
   * This method parses command-line arguments and flags, constructs the options for
   * the {@link prebidExplorer}, and then invokes it to perform the website scanning.
   * It includes logic for prioritizing URL input sources (GitHub repository over local file)
   * and handles potential errors during the scan.
   *
   * @returns A Promise that resolves when the command execution is complete.
   * @throws Error if no input source is specified or if `prebidExplorer` throws an unhandled error.
   */
  public async run(): Promise<void> {
    const {args, flags} = await this.parse(Scan);

    const options: PrebidExplorerOptions = {
      puppeteerType: flags.puppeteerType as 'vanilla' | 'cluster',
      concurrency: flags.concurrency,
      headless: flags.headless,
      monitor: flags.monitor,
      outputDir: flags.outputDir,
      logDir: flags.logDir,
      numUrls: flags.numUrls,
      range: flags.range,
      chunkSize: flags.chunkSize,
      puppeteerLaunchOptions: {
        headless: flags.headless,
        // Common args for running in Docker/CI environments
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'],
      },
      // githubRepo and inputFile will be set below based on prioritization
    };

    // Input source prioritization
    if (flags.githubRepo) {
      this.log(`Fetching URLs from GitHub repository: ${flags.githubRepo}`);
      options.githubRepo = flags.githubRepo;
      // User explicitly provided args.inputFile but also --githubRepo, warn that inputFile will be ignored.
      if (args.inputFile && args.inputFile !== Scan.args.inputFile.default) { // Check against default to avoid warning when only default is present
        this.warn(`--githubRepo provided, inputFile argument ('${args.inputFile}') will be ignored.`);
      }
    } else if (args.inputFile) {
      this.log(`Using input file: ${args.inputFile}`);
      options.inputFile = args.inputFile;
    } else {
      // This case should not be reached if args.inputFile has a default value and no --githubRepo is given.
      // However, as a safeguard:
      this.error('No input source specified. Please provide the --githubRepo flag or an inputFile argument.', { exit: 1 });
      return; // Explicitly return to satisfy TypeScript, though this.error will exit.
    }

    this.log(`Starting Prebid scan with options:`);
    this.log(JSON.stringify(options, null, 2));

    try {
      await prebidExplorer(options);
      this.log('Prebid scan completed successfully.');
    } catch (error: any) {
      // Log the full error stack for better debugging if available
      this.log(`Full error during Prebid scan: ${error.stack || error.message || error}`);
      this.error(`An error occurred during the Prebid scan: ${error.message}`, {
        exit: 1,
        suggestions: ['Check logs in the specified logDir for more details.'],
      });
    }
  }
}
