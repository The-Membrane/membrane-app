import { extendTheme } from "@chakra-ui/react";

const theme = extendTheme({
    shadows: {
        base: "0 0 25px rgba(90, 90, 90, 0.5)",  // Override base shadow
        custom: "0px 6px 16px rgba(0, 0, 0, 0.25)", // Create a custom shadow
    },
});

export default theme;
