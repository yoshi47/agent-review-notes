// The changelog is shown on the Marketplace and Open VSX pages, so entries are
// the summary alone: the default generator's commit hash means nothing there.
export default {
  getReleaseLine({ summary }) {
    const [first, ...rest] = summary.trim().split('\n')
    const more = rest.map((l) => (l ? `  ${l}` : l)).join('\n')
    return `\n- ${first}${more ? `\n${more}` : ''}`
  },
  getDependencyReleaseLine: () => '',
}
