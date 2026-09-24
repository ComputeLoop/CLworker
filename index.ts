const API_URL = "https://cl.elysiavernight.com";
const WORKER_ID = "worker-" + crypto.randomUUID();
const PROJECT_ID = process.argv[2];

if (!PROJECT_ID) {
  console.error("❌ Please provide a project ID.");
  console.error("Usage: bun run index.ts <project-id>");
  process.exit(1);
}
console.log(`🤖 Worker started: ${WORKER_ID}`);

function findPrimes(start: number, end: number) {
  const primes: number[] = [];

  for (let number = start; number <= end; number++) {
    if (number < 2) continue;

    let isPrime = true;

    for (let divisor = 2; divisor * divisor <= number; divisor++) {
      if (number % divisor === 0) {
        isPrime = false;
        break;
      }
    }

    if (isPrime) {
      primes.push(number);
    }
  }

  return primes;
}
type Job = {
  id: string;
  projectId: string;
  jobNumber: number;
  status: string;
  workerId: string;
  input: {
    start: number;
    end: number;
  };
};
async function getJob() {
  try {
    const response = await fetch(
      `${API_URL}/jobs/next?workerId=${WORKER_ID}&projectId=${PROJECT_ID}`,
    );

    if (response.status === 404) {
      console.log("📭 No jobs available");
      return null;
    }

    if (!response.ok) {
      console.log(`⚠️ Server returned HTTP ${response.status}`);
      return null;
    }

    const job = (await response.json()) as Job;

    console.log("📦 Received job:");
    console.log(job);

    console.log(
      `🔬 Computing primes from ${job.input.start} to ${job.input.end}...`,
    );

    const primes = findPrimes(job.input.start, job.input.end);

    console.log(`✅ Computation finished! Found ${primes.length} primes.`);

    const completeResponse = await fetch(
      `${API_URL}/jobs/${job.id}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          result: `Found ${primes.length} primes`,
        }),
      },
    );

    if (!completeResponse.ok) {
      console.log(
        `❌ Failed to submit result (HTTP ${completeResponse.status})`,
      );
      return null;
    }

    const completedJob = await completeResponse.json();

    console.log("📤 Result submitted successfully!");
    console.log(completedJob);

    return job;
  } catch (error) {
    console.log("🌐 Connection error:", error);
    return null;
  }
}
while (true) {
  const job = await getJob();

  if (!job) {
    console.log("😴 No jobs available. Waiting...");
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
