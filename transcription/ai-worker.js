import { pipeline, env } from '../lib/transformers.min.js';

// Configure environment for optimal local browser execution
env.allowLocalModels = false; // We use HuggingFace Hub
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/Qwen1.5-0.5B-Chat';

let aiPipeline = null;

/**
 * Load the LLM pipeline
 */
async function loadModel() {
  if (aiPipeline) return aiPipeline;

  // WebGPU is not supported in Transformers.js v2.
  // We force WASM and enable multi-threading to heavily optimize CPU speed instead.
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 4;
  
  aiPipeline = await pipeline('text-generation', MODEL_ID, {
    dtype: 'q4',
    progress_callback: (progressData) => {
      if (progressData.status === 'progress' && progressData.progress != null) {
        self.postMessage({
          type: 'AI_PROGRESS',
          payload: { text: `Downloading AI model: ${Math.round(progressData.progress)}%` }
        });
      } else if (progressData.status === 'initiate') {
        self.postMessage({
          type: 'AI_PROGRESS',
          payload: { text: `Loading: ${progressData.file || 'model files'}...` }
        });
      } else if (progressData.status === 'done') {
        self.postMessage({
          type: 'AI_PROGRESS',
          payload: { text: `Downloaded ${progressData.file || 'file'}.` }
        });
      }
    }
  });

  return aiPipeline;
}

self.onmessage = async function(event) {
  const { type, payload } = event.data;

  if (type !== 'GENERATE_NOTES') return;

  const { transcriptText } = payload;

  try {
    self.postMessage({ type: 'AI_PROGRESS', payload: { text: 'Initializing AI Engine...' } });
    const generator = await loadModel();

    self.postMessage({ type: 'AI_PROGRESS', payload: { text: 'Analyzing transcript (this may take a few minutes)...' } });

    const systemPrompt = `You are an expert executive assistant. Analyze the following meeting transcript.
Provide a well-structured response in Markdown format with the following sections:
1. **Executive Summary**: A concise overview.
2. **Action Items**: A bulleted list of tasks assigned.
3. **Key Moments**: A bulleted list of insights.

Do not include conversational filler. Just the requested markdown.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Transcript:\n${transcriptText}` }
    ];

    // Format chat template
    const text = generator.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    });

    let tokensGenerated = 0;
    
    const output = await generator(text, {
      max_new_tokens: 512,
      temperature: 0.2,
      callback_function: (beams) => {
        tokensGenerated++;
        if (tokensGenerated % 5 === 0) {
          self.postMessage({ 
            type: 'AI_PROGRESS', 
            payload: { text: `Generating notes... (${tokensGenerated} tokens)` } 
          });
        }
      }
    });

    let generatedText = output[0].generated_text;
    
    // The output usually contains the prompt as well, so we strip it.
    if (generatedText.includes('<|im_start|>assistant\n')) {
      generatedText = generatedText.split('<|im_start|>assistant\n').pop().trim();
    } else {
      // Fallback fallback
      generatedText = generatedText.replace(text, '').trim();
    }

    self.postMessage({
      type: 'AI_COMPLETE',
      payload: { result: generatedText }
    });

  } catch (error) {
    console.error('[AI Worker] Generation failed:', error);
    self.postMessage({
      type: 'AI_ERROR',
      payload: { error: error.message }
    });
  }
};
