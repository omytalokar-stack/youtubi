export const PROCEDURAL_SCENE_COUNT = 8;

export function generateSceneAssets(scenePrompts) {
  if (!Array.isArray(scenePrompts) || scenePrompts.length !== PROCEDURAL_SCENE_COUNT) {
    throw new TypeError(`Exactly ${PROCEDURAL_SCENE_COUNT} scene prompts are required.`);
  }
  if (scenePrompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
    throw new TypeError('Every procedural scene requires a non-empty prompt.');
  }
  return scenePrompts.map((prompt, index) => ({
    type: 'procedural',
    prompt: prompt.trim(),
    index
  }));
}
