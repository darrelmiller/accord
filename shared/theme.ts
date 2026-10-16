// This fixed, source-preserved bootstrap is the only supported active-script spelling.
// The isolated preview never executes it.
export const themeBootstrap = `(() => {
    const param = new URLSearchParams(window.location.search).get("scoutTheme");
    const theme =
      param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();`;
