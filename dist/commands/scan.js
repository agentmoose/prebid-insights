import { Command } from '@oclif/core'; // Added Interfaces
// Step 1: Import prebidExplorer and PrebidExplorerOptions
import { prebidExplorer } from '../prebid.js'; // Assuming .js for NodeNext resolution
import { scanArgs, scanFlags } from './scan-options.js';
/**
 * Defines the Scan command for the CLI.
 * This command scans websites for Prebid.js integrations.
 */
export default class Scan extends Command {
    /**
     * Defines the arguments for the Scan command.
     */
    static args = scanArgs;
    /**
     * Provides a description for the Scan command.
     */
    static description = 'Scans websites for Prebid.js integrations. InputFile can be .txt, .csv, or .json.';
    /**
     * Provides examples of how to use the Scan command.
     */
    static examples = [
        '<%= config.bin %> <%= command.id %> websites.txt --puppeteerType=cluster --concurrency=10',
        '<%= config.bin %> <%= command.id %> --githubRepo https://github.com/user/repo --numUrls 50',
    ];
    /**
     * Defines the flags for the Scan command.
     */
    static flags = scanFlags;
    /**
     * Executes the Scan command.
     * This method parses the arguments and flags, then calls the prebidExplorer function.
     * @returns {Promise<void>} A promise that resolves when the command has finished executing.
     */
    /**
     * Creates the {@link PrebidExplorerOptions} object based on the parsed command-line flags.
     *
     * @param flags - The parsed flags object obtained from `this.parse(Scan)`. Expected to conform to the structure defined in `Scan.flags`.
     * @returns A {@link PrebidExplorerOptions} object configured with values from the flags.
     */
    _getPrebidExplorerOptions(flags) {
        return {
            puppeteerType: flags.puppeteerType,
            concurrency: flags.concurrency,
            headless: flags.headless,
            monitor: flags.monitor,
            outputDir: flags.outputDir,
            logDir: flags.logDir,
            numUrls: flags.numUrls, // Relevant for GitHub source
            range: flags.range,
            chunkSize: flags.chunkSize,
            puppeteerLaunchOptions: {
                headless: flags.headless,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
            // githubRepo and inputFile are set by _getInputSourceOptions
        };
    }
    /**
     * Determines the input source (file or GitHub repository) and updates the provided PrebidExplorerOptions object.
     * This method prioritizes GitHub repository if specified, otherwise uses the input file.
     * It logs information about the chosen source and warns if `inputFile` is ignored due to `githubRepo` being present.
     *
     * @param args - The parsed arguments object obtained from `this.parse(Scan)`. Expected to conform to the structure defined in `Scan.args`.
     * @param flags - The parsed flags object obtained from `this.parse(Scan)`. Expected to conform to the structure defined in `Scan.flags`.
     * @param options - The {@link PrebidExplorerOptions} object to be modified with input source details.
     */
    _getInputSourceOptions(args, flags, options) {
        if (flags.githubRepo) {
            this.log(`Fetching URLs from GitHub repository: ${flags.githubRepo}`);
            options.githubRepo = flags.githubRepo;
            if (args.inputFile && args.inputFile !== 'src/input.txt') {
                this.warn(`--githubRepo provided, inputFile argument ('${args.inputFile}') will be ignored.`);
            }
        }
        else if (args.inputFile) {
            this.log(`Using input file: ${args.inputFile}`);
            options.inputFile = args.inputFile;
        }
        else {
            this.error('No input source specified. Please provide --githubRepo or an inputFile argument.', { exit: 1 });
        }
    }
    async run() {
        const { args, flags } = await this.parse(Scan);
        const options = this._getPrebidExplorerOptions(flags);
        this._getInputSourceOptions(args, flags, options);
        this.log(`Starting Prebid scan with options:`);
        this.log(JSON.stringify(options, null, 2));
        try {
            await prebidExplorer(options);
            this.log('Prebid scan completed successfully.');
        }
        catch (error) {
            const err = error;
            this.log(`Full error during Prebid scan: ${err.stack || err}`); // Log full error
            this.error(`An error occurred during the Prebid scan: ${err.message}`, {
                exit: 1,
                suggestions: ['Check logs for more details.'], // Suggestions are fine
            });
        }
    }
}
