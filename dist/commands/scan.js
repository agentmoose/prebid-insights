import { Args, Command, Flags } from '@oclif/core';
// Step 1: Import prebidExplorer and PrebidExplorerOptions
import { prebidExplorer } from '../prebid.js'; // Assuming .js for NodeNext resolution
class Scan extends Command {
    async run() {
        const { args, flags } = await this.parse(Scan);
        let inputFile = args.inputFile;
        let githubRepo = flags.githubRepo;
        let csvFile = flags.csvFile;
        // Input validation and prioritization
        if (csvFile) {
            this.log(`Using CSV file: ${csvFile}`);
            if (githubRepo) {
                this.warn('--csvFile provided, --githubRepo will be ignored.');
                githubRepo = undefined;
            }
            if (inputFile && inputFile !== 'src/input.txt') {
                this.warn('--csvFile provided, inputFile argument will be ignored.');
                inputFile = undefined;
            }
            else if (inputFile === 'src/input.txt' && !flags.githubRepo) {
                // if default inputFile is used and no githubRepo, it should be ignored in favor of csvFile
                inputFile = undefined;
            }
        }
        else if (githubRepo) {
            this.log(`Fetching URLs from GitHub repository: ${githubRepo}`);
            if (inputFile && inputFile !== 'src/input.txt') {
                this.warn('--githubRepo provided, inputFile argument will be ignored.');
                inputFile = undefined;
            }
            else if (inputFile === 'src/input.txt') {
                inputFile = undefined; // Default inputFile is ignored if githubRepo is present
            }
        }
        else if (inputFile) {
            this.log(`Using input file: ${inputFile}`);
        }
        else {
            // This case implies csvFile, githubRepo are null, and inputFile is also null or default but overridden.
            // The args.inputFile now has a default, so this condition needs to check if it's still the default
            // and no other input was specified.
            // However, the logic above should correctly set inputFile to undefined if another source is prioritized.
            // So, if inputFile is still 'src/input.txt' here AND no other flag was set, it means no specific input was chosen.
            // Let's refine the final check for any valid input source.
        }
        // Final check for input source
        if (!csvFile && !githubRepo && (!inputFile || inputFile === 'src/input.txt' && !flags.csvFile && !flags.githubRepo)) {
            // If inputFile is still the default and no csvFile or githubRepo was specified,
            // it means the user likely didn't provide any specific input.
            // However, oclif defaults inputFile to 'src/input.txt'.
            // A more robust check: if no explicit input flag/arg (other than default inputFile) is given.
            // The logic above should correctly undefined inputFile if csvFile or githubRepo is used.
            // So, if all are undefined/default, then error.
            if (!csvFile && !githubRepo && (inputFile === 'src/input.txt' && !args.inputFile && !flags.githubRepo && !flags.csvFile)) {
                // This condition is tricky. Let's re-evaluate.
                // If csvFile is set, it's used.
                // Else if githubRepo is set, it's used.
                // Else if inputFile is set (and it's not the default *unless* it was explicitly passed), it's used.
                // If none of these conditions are met, then error.
                // The args.inputFile has a default. So, we need to check if it was explicitly passed
                // or if it's just the default and no other input was given.
                // Simplified: if after prioritization, all specific inputs are undefined, and inputFile is the default (and wasn't explicitly set)
                let explicitInputFile = false;
                for (const arg of this.argv) {
                    if (arg === inputFile && inputFile !== 'src/input.txt') { // explicitly passed a non-default
                        explicitInputFile = true;
                        break;
                    }
                    if (arg === inputFile && inputFile === 'src/input.txt') { // explicitly passed the default
                        explicitInputFile = true;
                        break;
                    }
                }
                // If no csvFile, no githubRepo, and inputFile is the default src/input.txt *and* it wasn't explicitly passed by the user
                if (!csvFile && !githubRepo && inputFile === 'src/input.txt' && !explicitInputFile) {
                    this.error('No input source specified. Please provide --csvFile, --githubRepo, or an inputFile argument.', { exit: 1 });
                }
                else if (!csvFile && !githubRepo && !inputFile) { // Covers cases where inputFile became undefined due to prioritization
                    this.error('No input source specified. Please provide --csvFile, --githubRepo, or an inputFile argument.', { exit: 1 });
                }
            } // Closing for the inner if: if (!csvFile && !githubRepo && (inputFile === 'src/input.txt' && !args.inputFile && !flags.githubRepo && !flags.csvFile) )
        } // Closing for the outer if: if (!csvFile && !githubRepo && (!inputFile || inputFile === 'src/input.txt' && !flags.csvFile && !flags.githubRepo))
        // Construct PrebidExplorerOptions object
        const options = {
            puppeteerType: flags.puppeteerType,
            concurrency: flags.concurrency,
            headless: flags.headless, // Set the top-level headless property
            monitor: flags.monitor,
            outputDir: flags.outputDir,
            logDir: flags.logDir,
            githubRepo: githubRepo, // Use the potentially modified variable
            csvFile: csvFile, // Add csvFile to options
            numUrls: flags.numUrls,
            range: flags.range,
            chunkSize: flags.chunkSize,
            puppeteerLaunchOptions: {
                headless: flags.headless, // Also set within puppeteerLaunchOptions for clarity/consistency
                args: [
                    '--no-sandbox', // Default argument
                    '--disable-setuid-sandbox',
                    // Add other default args as needed
                ],
                // Potentially merge with user-provided args if a flag for that is added
            },
        };
        // Set inputFile in options based on the prioritized logic
        if (csvFile) {
            options.inputFile = undefined;
            options.githubRepo = undefined;
        }
        else if (githubRepo) {
            options.inputFile = undefined;
        }
        else if (inputFile) {
            options.inputFile = inputFile;
        }
        else {
            // If all are undefined, it implies the default inputFile should be used,
            // or an error if it was also meant to be ignored (e.g. user explicitly typed 'src/input.txt' with other flags)
            // However, the error check above should catch no-input scenarios.
            // If inputFile is 'src/input.txt' (default) and no other inputs given, it's the one to use.
            if (inputFile === 'src/input.txt' && !githubRepo && !csvFile) {
                options.inputFile = inputFile;
                this.log(`Using default input file: ${inputFile}`);
            }
            else {
                options.inputFile = undefined; // Should have been caught by error logic if no input was truly intended
            }
        }
        this.log(`Starting Prebid scan with options:`);
        this.log(JSON.stringify(options, null, 2));
        // Step 4 & 5: Call prebidExplorer with error handling
        try {
            await prebidExplorer(options);
            this.log('Prebid scan completed successfully.');
        }
        catch (error) {
            this.log(`Full error during Prebid scan: ${error.stack || error}`); // Log full error
            this.error(`An error occurred during the Prebid scan: ${error.message}`, {
                exit: 1,
                suggestions: ['Check logs for more details.'], // Suggestions are fine
            });
        }
    }
}
Scan.args = {
    inputFile: Args.string({ description: 'Input file path', required: false, default: 'src/input.txt' }),
};
Scan.description = 'Scans websites for Prebid.js integrations.';
Scan.examples = [
    '<%= config.bin %> <%= command.id %> websites.txt --puppeteerType=cluster --concurrency=10',
    '<%= config.bin %> <%= command.id %> --githubRepo https://github.com/user/repo --numUrls 50',
];
Scan.flags = {
    githubRepo: Flags.string({
        description: 'GitHub repository URL to fetch URLs from',
        required: false,
    }),
    numUrls: Flags.integer({
        description: 'Number of URLs to load from the GitHub repository (used only with --githubRepo)',
        default: 100,
        required: false,
    }),
    puppeteerType: Flags.string({
        description: 'Type of Puppeteer to use',
        options: ['vanilla', 'cluster'],
        default: 'cluster',
    }),
    concurrency: Flags.integer({
        description: 'Number of concurrent Puppeteer instances',
        default: 5,
    }),
    headless: Flags.boolean({
        description: 'Run Puppeteer in headless mode',
        default: true,
        allowNo: true,
    }),
    monitor: Flags.boolean({
        description: 'Enable puppeteer-cluster monitoring',
        default: false,
    }),
    outputDir: Flags.string({
        description: 'Directory to save output files',
        default: 'store',
    }),
    logDir: Flags.string({
        description: 'Directory to save log files',
        default: 'logs',
    }),
    csvFile: Flags.string({
        description: 'CSV file path or GitHub URL to fetch URLs from. Assumes URLs are in the first column.',
        required: false,
    }),
    range: Flags.string({ description: "Specify a line range (e.g., '10-20' or '5-') to process from the input source. 1-based indexing.", required: false }),
    chunkSize: Flags.integer({ description: "Process URLs in chunks of this size. Processes all URLs in the specified range or input, but one chunk at a time.", required: false }),
};
export default Scan;
