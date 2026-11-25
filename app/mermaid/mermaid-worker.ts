import { PeleError, render } from "pele";
import { MERMAID_SOURCE_LIMIT, type DiagramRequest, type DiagramResponse } from "./protocol";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DiagramRequest>) => void;
  postMessage: (response: DiagramResponse) => void;
};

scope.onmessage = ({ data: { source, width, fontFamily, fontFamilyMono } }) => {
  try {
    const diagram = render(source, {
      maxWidth: width,
      fontFamily,
      fontFamilyMono,
      idPrefix: "xiangying-diagram",
      autoDirection: false,
      links: false,
      images: false,
      limit: MERMAID_SOURCE_LIMIT,
      maxEdges: 5_000,
      outputLimit: 4_000_000,
    });
    scope.postMessage({
      result: { svg: diagram.svg, width: diagram.width, height: diagram.height },
    });
  } catch (error) {
    if (error instanceof PeleError) {
      scope.postMessage({
        failure: {
          code: error.code,
          message: error.message,
          line: error.line,
          column: error.column,
        },
      });
    } else {
      scope.postMessage({
        failure: { code: "render", message: "图表渲染失败", line: 0, column: 0 },
      });
    }
  }
};
