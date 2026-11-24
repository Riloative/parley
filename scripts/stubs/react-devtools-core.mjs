// Stand-in for Ink's optional React DevTools integration in the standalone
// binary, which cannot load packages from disk. Only used when DEV=true.
const devtools = {
  initialize() {},
  connectToDevTools() {
    throw new Error('React DevTools are not available in the standalone taria binary.');
  },
};
export default devtools;
