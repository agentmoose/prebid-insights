import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename: string = fileURLToPath(import.meta.url);
const __dirname: string = path.dirname(__filename);

const outputDir: string = path.join(__dirname, '..', 'store');
const finalApiFilePath: string = path.join(__dirname, '..', '..', 'api', 'api.json');
const MIN_COUNT_THRESHOLD: number = 5;

interface SiteData {
    url?: string;
    prebidInstances?: PrebidInstanceData[];
}

interface PrebidInstanceData {
    version?: string;
    modules?: string[];
}

interface VersionDistribution {
    [version: string]: number;
}

interface ModuleDistribution {
    [moduleName: string]: number;
}

interface FinalApiData {
    visitedSites: number;
    monitoredSites: number;
    prebidSites: number;
    releaseVersions: VersionDistribution;
    buildVersions: VersionDistribution;
    customVersions: VersionDistribution;
    bidAdapterInst: ModuleDistribution;
    idModuleInst: ModuleDistribution;
    rtdModuleInst: ModuleDistribution;
    analyticsAdapterInst: ModuleDistribution;
    otherModuleInst: ModuleDistribution;
    bidAdapterWebsites?: ModuleDistribution;
    idModuleWebsites?: ModuleDistribution;
    rtdModuleWebsites?: ModuleDistribution;
    analyticsAdapterWebsites?: ModuleDistribution;
    otherModuleWebsites?: ModuleDistribution;
}

interface VersionComponents {
    major: number;
    minor: number;
    patch: number;
    preRelease: string | null;
}

function parseVersion(versionString: string | undefined): VersionComponents {
    if (!versionString) {
        console.warn(`Attempted to parse null or undefined version string.`);
        return { major: 0, minor: 0, patch: 0, preRelease: 'invalid' };
    }
    const match: RegExpMatchArray | null = versionString.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) {
        console.warn(`Could not parse version: ${versionString}`);
        return { major: 0, minor: 0, patch: 0, preRelease: versionString };
    }
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        preRelease: match[4] || null,
    };
}

function compareVersions(a: string, b: string): number {
    const vA: VersionComponents = parseVersion(a);
    const vB: VersionComponents = parseVersion(b);

    if (vA.major !== vB.major) return vB.major - vA.major;
    if (vA.minor !== vB.minor) return vB.minor - vA.minor;
    if (vA.patch !== vB.patch) return vB.patch - vA.patch;

    if (vA.preRelease === null && vB.preRelease !== null) return -1;
    if (vA.preRelease !== null && vB.preRelease === null) return 1;

    if (vA.preRelease && vB.preRelease) {
        if (vA.preRelease < vB.preRelease) return -1;
        if (vA.preRelease > vB.preRelease) return 1;
    }
    return 0;
}

/**
 * Main function to summarize and then clean statistics.
 */
async function updateAndCleanStats(): Promise<void> {
    const rawVersionCounts: VersionDistribution = {};
    const rawModuleCounts: ModuleDistribution = {};
    const moduleWebsiteData: { [moduleName: string]: Set<string> } = {}; // To store unique URLs for each module
    const uniqueUrls: Set<string> = new Set();
    const urlsWithPrebid: Set<string> = new Set();
    const monthAbbrRegex: RegExp = /^[A-Z][a-z]{2}$/;

    try {
        const outputEntries: import('fs').Dirent[] = await fsPromises.readdir(outputDir, { withFileTypes: true });

        for (const entry of outputEntries) {
            if (entry.isDirectory() && monthAbbrRegex.test(entry.name)) {
                const monthDirPath: string = path.join(outputDir, entry.name);
                const files: string[] = await fsPromises.readdir(monthDirPath);

                for (const file of files) {
                    // console.log(`TEMPORARY DEBUG: Processing file: ${path.join(monthDirPath, file)}`); // Restore
                    if (path.extname(file).toLowerCase() === '.json') {
                        const filePath: string = path.join(monthDirPath, file);
                        try {
                            const fileContent: string = await fsPromises.readFile(filePath, 'utf8');

                            const siteEntries: SiteData[] = JSON.parse(fileContent);

                            if (Array.isArray(siteEntries)) {
                                siteEntries.forEach((siteData: SiteData) => {
                                    const currentUrl: string | undefined = siteData?.url?.trim();
                                    let hasPrebidInstance: boolean = false;

                                    if (currentUrl) {
                                        uniqueUrls.add(currentUrl);
                                    }

                                    if (Array.isArray(siteData.prebidInstances)) {
                                        siteData.prebidInstances.forEach((instance: PrebidInstanceData) => {
                                            if (instance) {
                                                hasPrebidInstance = true;

                                                if (typeof instance.version === 'string') {
                                                    const version: string = instance.version.trim();
                                                    if (version) {
                                                        rawVersionCounts[version] = (rawVersionCounts[version] || 0) + 1;
                                                    }
                                                }

                                                if (Array.isArray(instance.modules)) {
                                                    instance.modules.forEach((moduleName: string) => {
                                                        if (typeof moduleName === 'string') {
                                                            const trimmedModule: string = moduleName.trim();
                                                            if (trimmedModule) {
                                                                rawModuleCounts[trimmedModule] = (rawModuleCounts[trimmedModule] || 0) + 1;
                                                                // Populate moduleWebsiteData
                                                                if (currentUrl) {
                                                                    if (!moduleWebsiteData[trimmedModule]) {
                                                                        moduleWebsiteData[trimmedModule] = new Set();
                                                                    }
                                                                    moduleWebsiteData[trimmedModule].add(currentUrl);
                                                                }
                                                            }
                                                        }
                                                    });
                                                }
                                            }
                                        });
                                    }
                                    if (currentUrl && hasPrebidInstance) {
                                        urlsWithPrebid.add(currentUrl);
                                    }
                                });
                            }
                        } catch (parseError: any) {
                            const errorMessage = `Error parsing JSON file ${filePath}:`;
                            logger.instance.error(errorMessage, { errorName: parseError.name, errorMessage: parseError.message, stack: parseError.stack });
                        }
                    }
                }
            }
        }

        const sortedRawVersions: string[] = Object.keys(rawVersionCounts).sort(compareVersions);
        const sortedRawVersionCounts: VersionDistribution = {};
        for (const version of sortedRawVersions) {
            sortedRawVersionCounts[version] = rawVersionCounts[version];
        }

        const sortedRawModules: string[] = Object.keys(rawModuleCounts).sort((a, b) => rawModuleCounts[b] - rawModuleCounts[a]);
        const sortedRawModuleCounts: ModuleDistribution = {};
        for (const moduleName of sortedRawModules) {
            sortedRawModuleCounts[moduleName] = rawModuleCounts[moduleName];
        }

        const finalApiData: FinalApiData = {
            visitedSites: uniqueUrls.size,
            monitoredSites: uniqueUrls.size,
            prebidSites: urlsWithPrebid.size,
            releaseVersions: {},
            buildVersions: {},
            customVersions: {},
            bidAdapterInst: {},
            idModuleInst: {},
            rtdModuleInst: {},
            analyticsAdapterInst: {},
            otherModuleInst: {},
            // Initialize website count fields
            bidAdapterWebsites: {},
            idModuleWebsites: {},
            rtdModuleWebsites: {},
            analyticsAdapterWebsites: {},
            otherModuleWebsites: {}
        };

        // Process versionDistribution from sortedRawVersionCounts
        const versionDistributionForCleaning: VersionDistribution = sortedRawVersionCounts;
        for (const version in versionDistributionForCleaning) {
            const count: number = versionDistributionForCleaning[version];
            const cleanedVersion: string = version.startsWith('v') ? version.substring(1) : version;

            if (version.endsWith('-pre')) {
                finalApiData.buildVersions[cleanedVersion] = count;
            } else if (version.includes('-')) {
                finalApiData.customVersions[cleanedVersion] = count;
            } else {
                if (cleanedVersion.includes('.')) {
                    finalApiData.releaseVersions[cleanedVersion] = count;
                } else {
                    finalApiData.customVersions[cleanedVersion] = count;
                }
            }
        }

        // Process moduleDistribution from sortedRawModuleCounts
        const moduleDistributionForCleaning: ModuleDistribution = sortedRawModuleCounts;
        for (const moduleName in moduleDistributionForCleaning) {
            const count: number = moduleDistributionForCleaning[moduleName];

            if (count < MIN_COUNT_THRESHOLD) {
                continue;
            }

            if (moduleName.includes('BidAdapter')) {
                finalApiData.bidAdapterInst[moduleName] = count;
            } else if (moduleName.includes('IdSystem') || moduleName === 'userId' || moduleName === 'idImportLibrary' || moduleName === 'pubCommonId' || moduleName === 'utiqSystem' || moduleName === 'trustpidSystem') {
                finalApiData.idModuleInst[moduleName] = count;
            } else if (moduleName.includes('RtdProvider') || moduleName === 'rtdModule') {
                finalApiData.rtdModuleInst[moduleName] = count;
            } else if (moduleName.includes('AnalyticsAdapter')) {
                finalApiData.analyticsAdapterInst[moduleName] = count;
            } else {
                finalApiData.otherModuleInst[moduleName] = count;
            }
        }

        // Convert moduleWebsiteData (Set<string>) to moduleWebsiteCountsNumeric (number)
        const moduleWebsiteCountsNumeric: ModuleDistribution = {};
        for (const moduleName in moduleWebsiteData) {
            moduleWebsiteCountsNumeric[moduleName] = moduleWebsiteData[moduleName].size;
        }

        // Process moduleWebsiteCountsNumeric to populate website count fields
        for (const moduleName in moduleWebsiteCountsNumeric) {
            const count: number = moduleWebsiteCountsNumeric[moduleName];

            if (count < MIN_COUNT_THRESHOLD) {
                continue;
            }

            if (moduleName.includes('BidAdapter')) {
                finalApiData.bidAdapterWebsites![moduleName] = count;
            } else if (moduleName.includes('IdSystem') || moduleName === 'userId' || moduleName === 'idImportLibrary' || moduleName === 'pubCommonId' || moduleName === 'utiqSystem' || moduleName === 'trustpidSystem') {
                finalApiData.idModuleWebsites![moduleName] = count;
            } else if (moduleName.includes('RtdProvider') || moduleName === 'rtdModule') {
                finalApiData.rtdModuleWebsites![moduleName] = count;
            } else if (moduleName.includes('AnalyticsAdapter')) {
                finalApiData.analyticsAdapterWebsites![moduleName] = count;
            } else {
                finalApiData.otherModuleWebsites![moduleName] = count;
            }
        }

        const targetApiDir = path.dirname(finalApiFilePath);
        try {
            await fsPromises.access(targetApiDir);
        } catch (error) {
            await fsPromises.mkdir(targetApiDir, { recursive: true });
        }

        await fsPromises.writeFile(finalApiFilePath, JSON.stringify(finalApiData, null, 2));
        console.log(`Successfully created ${finalApiFilePath}`);

    } catch (err: any) {
        const errorMessage = 'Error processing stats:';
        logger.instance.error(errorMessage, { errorName: err.name, errorMessage: err.message, stack: err.stack });
    }
}

export { updateAndCleanStats };
