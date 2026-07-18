import { DocLoader } from './doc-loader.port';

export const textLoader: DocLoader = {
  load: (buffer) =>
    Promise.resolve({ text: buffer.toString('utf-8'), meta: {} }),
};
