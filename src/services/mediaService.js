import { transcribeAudio } from './aiService.js';

export const VOICE_PREFIX = '[Nota de voz transcrita]';
const UNREADABLE_AUDIO =
  '[El cliente envió una nota de voz que no se pudo entender; pídale amablemente que la repita o que escriba su consulta]';

/**
 * Convierte una nota de voz en el texto que procesará Bárbara.
 * @param {() => Promise<{ mimeType: string, data: string }|null>} download  descarga el audio en base64
 */
export async function voiceNoteToText(download) {
  try {
    const audio = await download();
    if (!audio?.data) return UNREADABLE_AUDIO;
    const transcript = await transcribeAudio(audio);
    return transcript ? `${VOICE_PREFIX} ${transcript}` : UNREADABLE_AUDIO;
  } catch (err) {
    console.error('No se pudo transcribir la nota de voz:', err.hint ?? err.message);
    return UNREADABLE_AUDIO;
  }
}
