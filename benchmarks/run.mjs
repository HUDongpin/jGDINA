import { performance } from "node:perf_hooks";
import { resourceUsage } from "node:process";
import {
  DEFAULT_RESOURCE_LIMITS,
  estimateFitMemory,
  fit,
  formatBytes,
  validateFitInput,
} from "../packages/jgdina/dist/index.js";

const CASES = Object.freeze({
  smoke: { n: 512, j: 12, k: 4 },
  "local-sim10gdina": { n: 1_000, j: 10, k: 3 },
  "local-sim30gdina": { n: 1_000, j: 30, k: 5 },
  "browser-stress": { n: 3_000, j: 30, k: 10 },
  "node-stress": { n: 10_000, j: 50, k: 12 },
  "browser-memory-preflight-k15": { n: 3_000, j: 30, k: 15, preflightOnly: true },
});

const options = parseArguments(process.argv.slice(2));
const shape = CASES[options.caseId];
if (shape === undefined) {
  throw new Error(`Unknown case '${options.caseId}'. Choose: ${Object.keys(CASES).join(", ")}`);
}

const input = syntheticInput(shape, options.posteriorStorage);
const validated = validateFitInput(input);
if (shape.preflightOnly === true || options.preflightOnly) {
  const reducedClassCounts = input.qMatrix.map(
    (row) => 2 ** row.reduce((sum, value) => sum + value, 0),
  );
  const estimates = Object.fromEntries(
    ["full", "scores-only"].map((posteriorStorage) => {
      const estimate = estimateFitMemory({
        respondents: shape.n,
        items: shape.j,
        attributes: shape.k,
        posteriorStorage,
        reducedClassCounts,
        starts: 1,
      });
      return [posteriorStorage, {
        ...estimate,
        formattedEstimatedBytes: formatBytes(estimate.estimatedBytes),
        exceedsDefaultLimit:
          estimate.estimatedBytes > DEFAULT_RESOURCE_LIMITS.maxEstimatedBytes,
      }];
    }),
  );
  process.stdout.write(
    `${JSON.stringify({
      caseId: options.caseId,
      execution: "preflight-only",
      dimensions: validated.dimensions,
      defaultLimitBytes: DEFAULT_RESOURCE_LIMITS.maxEstimatedBytes,
      estimates,
    }, null, 2)}\n`,
  );
  process.exit(0);
}

for (let run = 0; run < options.warmups; run += 1) await fit(input);

const samples = [];
for (let run = 0; run < options.runs; run += 1) {
  const beforeRss = process.memoryUsage().rss;
  const started = performance.now();
  const result = await fit(input);
  const wallMilliseconds = performance.now() - started;
  const afterRss = process.memoryUsage().rss;
  samples.push({
    wallMilliseconds,
    rssDeltaBytes: afterRss - beforeRss,
    maxResidentBytes: resourceUsage().maxRSS * 1024,
    iterations: result.convergence.iterations,
    finalLogLikelihood: result.statistics.logLikelihood,
  });
}

const times = samples.map((sample) => sample.wallMilliseconds).sort((a, b) => a - b);
process.stdout.write(
  `${JSON.stringify({
    caseId: options.caseId,
    dimensions: validated.dimensions,
    posteriorStorage: options.posteriorStorage,
    warmupFits: options.warmups,
    measuredFits: options.runs,
    medianWallMilliseconds: percentile(times, 0.5),
    p95WallMilliseconds: percentile(times, 0.95),
    peakResidentBytes: Math.max(...samples.map((sample) => sample.maxResidentBytes)),
    memoryEstimate: validated.memoryEstimate,
    samples,
  }, null, 2)}\n`,
);

function parseArguments(args) {
  const read = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const caseId = read("--case", "smoke");
  const warmups = Number(read("--warmups", "1"));
  const runs = Number(read("--runs", "5"));
  const posteriorStorage = read("--posterior", "scores-only");
  if (!Number.isSafeInteger(warmups) || warmups < 0) throw new Error("--warmups must be >= 0");
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be >= 1");
  if (posteriorStorage !== "full" && posteriorStorage !== "scores-only") {
    throw new Error('--posterior must be "full" or "scores-only"');
  }
  return {
    caseId,
    warmups,
    runs,
    posteriorStorage,
    preflightOnly: args.includes("--preflight-only"),
  };
}

function syntheticInput(shape, posteriorStorage) {
  const random = mulberry32(0x4a474449);
  const qMatrix = Array.from({ length: shape.j }, (_, item) => {
    const row = Array(shape.k).fill(0);
    row[item % shape.k] = 1;
    if (item % 3 === 2 && shape.k > 1) row[(item * 3 + 1) % shape.k] = 1;
    return row;
  });
  // Guarantee every attribute is represented even for unusual custom shapes.
  for (let attribute = 0; attribute < shape.k; attribute += 1) {
    qMatrix[attribute % shape.j][attribute] = 1;
  }
  const responses = Array.from({ length: shape.n }, (_, person) => {
    const mastery = Array.from({ length: shape.k }, (_, attribute) =>
      ((person * 1103515245 + attribute * 2654435761) >>> (attribute % 13)) & 1,
    );
    return qMatrix.map((qRow, item) => {
      let required = 0;
      let mastered = 0;
      for (let attribute = 0; attribute < shape.k; attribute += 1) {
        if (qRow[attribute] === 1) {
          required += 1;
          mastered += mastery[attribute];
        }
      }
      const probability = 0.12 + 0.76 * (mastered / required);
      if ((person + item * 17) % 97 === 0) return null;
      return random() < probability ? 1 : 0;
    });
  });
  return {
    responses,
    qMatrix,
    model: "GDINA",
    estimation: {
      maxIterations: 500,
      convergenceTolerance: 1e-5,
      posteriorStorage,
      initialization: { starts: 1, seed: 123_456 },
    },
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const index = Math.ceil(probability * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
