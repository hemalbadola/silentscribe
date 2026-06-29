/**
 * SilentScribe — OPFS Storage Module
 * ============================================================================
 * Handles Origin Private File System operations for storing media.
 */

const LOG_PREFIX = '[SilentScribe OPFS]';

/**
 * Get the OPFS root directory.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getOpfsRoot() {
  return await navigator.storage.getDirectory();
}

/**
 * Delete a file from OPFS.
 * @param {string} filename 
 */
export async function deleteFile(filename) {
  try {
    const root = await getOpfsRoot();
    await root.removeEntry(filename);
    console.log(LOG_PREFIX, 'Deleted file:', filename);
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      console.error(LOG_PREFIX, 'Failed to delete file:', filename, err);
    }
  }
}

/**
 * Get a FileSystemWritableFileStream to stream data into a file.
 * @param {string} filename 
 * @returns {Promise<FileSystemWritableFileStream>}
 */
export async function createWriteStream(filename) {
  const root = await getOpfsRoot();
  const fileHandle = await root.getFileHandle(filename, { create: true });
  return await fileHandle.createWritable();
}

/**
 * Read a file from OPFS as a Blob.
 * @param {string} filename 
 * @returns {Promise<File|null>}
 */
export async function readFile(filename) {
  try {
    const root = await getOpfsRoot();
    const fileHandle = await root.getFileHandle(filename);
    return await fileHandle.getFile();
  } catch (err) {
    if (err.name === 'NotFoundError') return null;
    throw err;
  }
}
