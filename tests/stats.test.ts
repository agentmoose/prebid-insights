import { describe, it, expect, beforeEach, afterEach } from 'vitest'; // Added vi
import { updateAndCleanStats } from '../src/utils/update_stats.js'; // Changed to .js
import mockFs from 'mock-fs'; // Restore mock-fs
import fs from 'fs';
import path from 'path';

import { FinalApiData } from '../src/utils/update_stats.js'; // Importing for clarity

const readMockJson = (filePath: string) => {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')); // Restore readMockJson
};

describe('updateAndCleanStats', () => {
  beforeEach(() => {
    // mockFs({}); // General mockFs setup in beforeEach can be tricky if tests define their own specific structures.
    // Let each test define its full mock structure for clarity.
  });

  afterEach(() => {
    mockFs.restore(); // Restore the real file system after each test
  });

  it('should be a runnable test file', () => {
    expect(true).toBe(true);
  });

  it('should correctly summarize and clean stats, then write to api/api.json', async () => {
    const storePath = path.resolve(process.cwd(), 'src', 'store');
    // Copied mock data structure from the original test plan, adjusted for absolute storePath
    mockFs({
      [storePath]: {
        'Jan': {
          'data1.json': JSON.stringify([
            {
              url: 'http://site1.com',
              prebidInstances: [
                { version: 'v8.2.0', modules: ['rubiconBidAdapter', 'criteoIdSystem', 'sharedIdSystem', 'adagioAnalyticsAdapter', 'coreModuleOnly'] },
                { version: 'v8.1.0', modules: ['criteoIdSystem', 'anotherModule'] } // Added to test website count for criteoIdSystem
              ]
            },
            {
              url: 'http://site2.com',
              prebidInstances: [
                { version: '7.53.0', modules: ['rubiconBidAdapter', 'id5IdSystem', 'connectIdSystem', 'coreModuleOnly', 'belowThresholdModule'] }
              ]
            },
            {
              url: 'http://site3.com',
              prebidInstances: [{}]
            }
          ]),
          'data2.json': JSON.stringify([
            {
              url: 'http://site4.com',
              prebidInstances: [
                { version: 'v9.10.0-pre', modules: ['rubiconBidAdapter', 'pubCommonId', 'realTimeData', 'enrichmentRtdProvider'] }
              ]
            },
            {
              url: 'http://site5.com',
              prebidInstances: [
                { version: 'v1.2.3-custom', modules: ['rubiconBidAdapter', 'utiqSystem', 'customAnalyticsAdapter'] }
              ]
            },
            {
              url: 'http://site6.com',
              prebidInstances: [
                { version: '9.35', modules: ['rubiconBidAdapter', 'trustpidSystem', 'coreModuleOnly'] }
              ]
            }
          ]),
        },
        'Feb': {
          'data3.json': JSON.stringify([
            {
              url: 'http://site1.com', // Repeat site1
              prebidInstances: [
                { version: 'v8.2.0', modules: ['rubiconBidAdapter', 'criteoIdSystem', 'appnexusBidAdapter'] }
              ]
            },
            {
              url: 'http://site7.com', // No Prebid
            }
          ])
        },
        'Mar': { // Add more data to ensure some modules pass threshold
            'data4.json': JSON.stringify([
                { url: 'http://site8.com', prebidInstances: [{ version: 'v8.2.0', modules: ['rubiconBidAdapter', 'appnexusBidAdapter', 'criteoIdSystem'] }] },
                { url: 'http://site9.com', prebidInstances: [{ version: 'v8.2.0', modules: ['rubiconBidAdapter', 'appnexusBidAdapter', 'criteoIdSystem'] }] },
                { url: 'http://site10.com', prebidInstances: [{ version: 'v8.2.0', modules: ['rubiconBidAdapter', 'appnexusBidAdapter', 'criteoIdSystem', 'sharedIdSystem'] }] },
                { url: 'http://site11.com', prebidInstances: [{ version: 'v8.2.0', modules: ['appnexusBidAdapter', 'sharedIdSystem'] }] },
            ])
        }
      },
      'api': {}
    });


    await updateAndCleanStats();

    const outputPath = path.join('api', 'api.json');
    expect(fs.existsSync(outputPath)).toBe(true);
    const outputData = readMockJson(outputPath);

    // Assertions from the original test plan
    expect(outputData.visitedSites).toBe(11);
    expect(outputData.monitoredSites).toBe(11);
    expect(outputData.prebidSites).toBe(10);

    expect(outputData.releaseVersions['8.2.0']).toBe(6); // Corrected from 5 to 6
    expect(outputData.releaseVersions['7.53.0']).toBe(1);
    expect(outputData.releaseVersions['9.35']).toBe(1); // Moved from customVersions and corrected
    expect(outputData.buildVersions['9.10.0-pre']).toBe(1);
    expect(outputData.customVersions['1.2.3-custom']).toBe(1);
    expect(outputData.customVersions['9.35']).toBeUndefined(); // Should not be in customVersions

    // Module counts based on MIN_COUNT_THRESHOLD = 5 (defined in stats.test.ts)
    expect(outputData.bidAdapterInst['rubiconBidAdapter']).toBe(9); // Corrected from 8 to 9
    expect(outputData.bidAdapterInst['appnexusBidAdapter']).toBe(5);
    expect(outputData.idModuleInst['criteoIdSystem']).toBe(6); // Corrected from 5 to 6 based on data

    // These were previously expected to be undefined due to wrong threshold calculation in plan
    // Recalculating based on data:
    // sharedIdSystem: site1(Jan), site10(Mar), site11(Mar) = 3. This IS below threshold.
    // coreModuleOnly: site1(Jan), site2(Jan), site6(Jan) = 3. This IS below threshold.
    expect(outputData.idModuleInst['sharedIdSystem']).toBeUndefined();
    expect(outputData.otherModuleInst['coreModuleOnly']).toBeUndefined();

    expect(outputData.rtdModuleInst['realTimeData']).toBeUndefined();
    expect(outputData.analyticsAdapterInst['adagioAnalyticsAdapter']).toBeUndefined();
    expect(outputData.bidAdapterInst['nonExistentAdapter']).toBeUndefined();
    expect(outputData.otherModuleInst['belowThresholdModule']).toBeUndefined();

    // Website Counts (New Assertions)
    // MIN_COUNT_THRESHOLD = 5 also applies to website counts
    // Cast to FinalApiData for type safety, though assertions would work without it.
    const typedOutputData = outputData as FinalApiData;

    expect(typedOutputData.bidAdapterWebsites['rubiconBidAdapter']).toBe(8);
    expect(typedOutputData.bidAdapterWebsites['appnexusBidAdapter']).toBe(5);

    // criteoIdSystem is on 4 unique sites (site1, site8, site9, site10), below threshold of 5
    expect(typedOutputData.idModuleWebsites['criteoIdSystem']).toBeUndefined();
    // sharedIdSystem is on 3 unique sites (site1, site10, site11), below threshold
    expect(typedOutputData.idModuleWebsites['sharedIdSystem']).toBeUndefined();
    // coreModuleOnly is on 3 unique sites (site1, site2, site6), below threshold
    expect(typedOutputData.otherModuleWebsites['coreModuleOnly']).toBeUndefined();
    // anotherModule is on 1 unique site (site1), below threshold
    expect(typedOutputData.otherModuleWebsites['anotherModule']).toBeUndefined();
    
    // Check categories that should be empty based on current data
    expect(Object.keys(typedOutputData.rtdModuleWebsites || {}).length).toBe(0);
    expect(Object.keys(typedOutputData.analyticsAdapterWebsites || {}).length).toBe(0);
  });

  it('should handle empty store directory', async () => {
    // outputDir in update_stats.ts resolves to path.join(__dirname, '..', 'store')
    // where __dirname is /app/src/utils, so outputDir is /app/src/store
    const storePath = path.resolve(process.cwd(), 'src', 'store');
    mockFs({ // Define mock structure for this specific test
      [storePath]: {}, // Mock the specific absolute path
      'api': {} // api directory must exist for writeFile to place api.json
    });

    await updateAndCleanStats();

    const outputPath = path.join('api', 'api.json');
    expect(fs.existsSync(outputPath)).toBe(true); // Check if output file was created
    const outputData = readMockJson(outputPath);

    expect(outputData.visitedSites).toBe(0);
    expect(outputData.monitoredSites).toBe(0);
    expect(outputData.prebidSites).toBe(0);
    expect(Object.keys(outputData.releaseVersions).length).toBe(0);
    // Check one module category
    expect(Object.keys(outputData.bidAdapterInst || {}).length).toBe(0);
  });

  it('should handle store directory with empty month directories', async () => {
    const storePath = path.resolve(process.cwd(), 'src', 'store');
    mockFs({
      [storePath]: {
        'Jan': {}, // Empty month directory
        'Feb': {}  // Another empty month directory
      },
      'api': {}
    });

    // Removed incorrect console.log from here

    await updateAndCleanStats();
    const outputData = readMockJson(path.join('api', 'api.json'));
    expect(outputData.visitedSites).toBe(0);
    expect(outputData.monitoredSites).toBe(0);
    expect(outputData.prebidSites).toBe(0);
  });

  it('should handle store directory with month directories having no json files', async () => {
    const storePath = path.resolve(process.cwd(), 'src', 'store');
    mockFs({
      [storePath]: {
        'Jan': { 'not-a-json.txt': 'hello' }, // Month directory with a non-JSON file
      },
      'api': {}
    });
    await updateAndCleanStats();
    const outputData = readMockJson(path.join('api', 'api.json'));
    expect(outputData.visitedSites).toBe(0);
    expect(outputData.monitoredSites).toBe(0);
    expect(outputData.prebidSites).toBe(0);
  });
});
