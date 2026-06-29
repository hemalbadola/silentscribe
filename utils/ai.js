/**
 * SilentScribe — Cloud AI Module (NVIDIA NIM)
 * ============================================================================
 * Interfaces with the NVIDIA NIM API to generate on-device meeting intelligence
 * quickly using cloud infrastructure.
 */

const LOG_PREFIX = '[SilentScribe AI]';

/**
 * Helper to fetch the .env file locally from the extension package
 */
async function getEnvVars() {
  try {
    const response = await fetch(chrome.runtime.getURL('.env'));
    const text = await response.text();
    const env = {};
    text.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        env[match[1]] = match[2] ? match[2].trim() : '';
      }
    });
    return env;
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load .env file', err);
    return {};
  }
}

/**
 * Generate comprehensive meeting notes (Summary, Action Items, Key Moments) from a transcript.
 * @param {string} transcriptText - Formatted string of transcript
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<string>} The generated markdown notes.
 */
export async function generateAiNotes(transcriptText, onProgress) {
  if (onProgress) onProgress('Connecting to NVIDIA NIM...');
  
  const envVars = await getEnvVars();
  const apiKey = envVars['NVIDIA_NIM_API_KEY'];
  
  if (!apiKey) {
    throw new Error("NVIDIA_NIM_API_KEY is missing from the .env file.");
  }

  const systemPrompt = `You are an expert executive assistant. Analyze the following meeting transcript.
Provide a well-structured response in Markdown format with the following sections:
1. **Executive Summary**: A concise overview.
2. **Action Items**: A bulleted list of tasks assigned.
3. **Key Moments**: A bulleted list of insights.

Do not include conversational filler. Just the requested markdown.`;

  if (onProgress) onProgress('Generating AI notes...');

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Transcript:\n${transcriptText}` }
        ],
        temperature: 0.2,
        top_p: 0.7,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`NVIDIA API Error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    console.error(LOG_PREFIX, 'NIM Generation Failed:', err);
    throw err;
  }
}

/**
 * Uses LLM to clean up the raw transcript segments (fixes grammar, repetitions, stutters).
 * Preserves timestamps and speaker labels.
 * 
 * @param {Array} segments - Array of segment objects {start, end, text, speaker}
 * @returns {Promise<Array>} Cleaned segments
 */
export async function cleanupTranscript(segments) {
  if (!segments || segments.length === 0) return segments;

  const envVars = await getEnvVars();
  const apiKey = envVars['NVIDIA_NIM_API_KEY'];
  
  if (!apiKey) {
    console.warn("No NVIDIA API key found, skipping transcript cleanup.");
    return segments;
  }

  // Format segments for the prompt
  const formattedInput = segments.map((s, i) => `[ID:${i}] [${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.speaker || 'Unknown'}: ${s.text}`).join('\n');

  const systemPrompt = `You are a strict transcript editor. Your task is to clean up a raw speech-to-text transcript.
Rules:
1. Fix obvious grammatical errors, stutters, and repeated words.
2. DO NOT change the context, meaning, or hallucinate new words. Only replace a word if you are 100% sure it was a mis-transcription.
3. You must keep the EXACT same formatting: "[ID:N] [STARTs - ENDs] Speaker: Text" for every single line. Do not combine IDs.
4. Output only the cleaned transcript lines, nothing else.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Raw Transcript:\n${formattedInput}` }
        ],
        temperature: 0.1, // Very low temperature for strict factual adherence
        top_p: 0.7,
        max_tokens: 4096
      })
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn("AI cleanup failed. Falling back to raw transcript.");
      return segments;
    }

    const data = await response.json();
    const cleanedText = data.choices[0].message.content;

    // Parse the cleaned text back into segments
    const cleanedSegments = [];
    const lines = cleanedText.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^\[ID:(\d+)\]\s*\[([\d.]+)s\s*-\s*([\d.]+)s\]\s*(.*?):\s*(.*)$/);
      if (match) {
        const id = parseInt(match[1], 10);
        if (segments[id]) {
          cleanedSegments.push({
            start: parseFloat(match[2]),
            end: parseFloat(match[3]),
            speaker: match[4].trim(),
            text: match[5].trim()
          });
        }
      }
    }

    if (cleanedSegments.length === 0) {
        return segments;
    }
    
    return cleanedSegments;

  } catch (err) {
    console.error(LOG_PREFIX, 'Transcript Cleanup Failed:', err);
    return segments;
  }
}

/**
 * Generates a short, descriptive title for the meeting based on the transcript.
 * 
 * @param {Array} segments - Array of segment objects
 * @returns {Promise<string|null>} The generated title or null if failed
 */
export async function generateAiTitle(segments) {
  if (!segments || segments.length === 0) return null;

  const envVars = await getEnvVars();
  const apiKey = envVars['NVIDIA_NIM_API_KEY'];
  
  if (!apiKey) {
    return null;
  }

  const formattedInput = segments.map(s => s.text).join(' ').substring(0, 4000); // Only need the beginning/some context for a title

  const systemPrompt = `You are a helpful assistant. Generate a very short, concise, and descriptive title for this meeting based on the transcript. Maximum 5 words. Do not use quotes or any other punctuation around the title. Just output the title.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Meeting Transcript:\n${formattedInput}` }
        ],
        temperature: 0.3,
        top_p: 0.7,
        max_tokens: 20
      })
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    return data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to generate AI title:', err);
    return null;
  }
}

/**
 * Generates a short platform/context description based on transcript.
 * 
 * @param {Array} segments 
 * @returns {Promise<string|null>}
 */
export async function generateAiPlatform(segments) {
  if (!segments || segments.length === 0) return null;

  const envVars = await getEnvVars();
  const apiKey = envVars['NVIDIA_NIM_API_KEY'];
  if (!apiKey) return null;

  const formattedInput = segments.map((s) => `${s.speaker || 'Unknown'}: ${s.text}`).join('\n');
  const systemPrompt = `You are a helpful assistant. Based on this transcript, guess what type of media or meeting this is. Output ONLY a short 1-3 word category tag (e.g. "YouTube Video", "Zoom Meeting", "Podcast", "Interview", "Lecture"). Do not use quotes.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Meeting Transcript:\n${formattedInput}` }
        ],
        temperature: 0.3,
        top_p: 0.7,
        max_tokens: 10
      })
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    return data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to generate AI platform:', err);
    return null;
  }
}
