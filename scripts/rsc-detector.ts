#!/usr/bin/env node

import * as t from "@babel/types";
import traverse from "@babel/traverse";
import * as path from "path";

/**
 * 컴포넌트 타입
 */
export type ComponentType = "client" | "server";

/**
 * RSC 감지 결과
 */
export interface DetectionResult {
  type: ComponentType;
  confidence: number; // 0-100
  reasons: string[]; // 판정 근거
}

/**
 * React Server Component(RSC) 감지 클래스
 */
export class RSCDetector {
  // Client 전용 React 훅
  private static CLIENT_HOOKS = [
    "useState",
    "useEffect",
    "useLayoutEffect",
    "useReducer",
    "useCallback",
    "useMemo",
    "useRef",
    "useImperativeHandle",
    "useContext",
    "useSyncExternalStore",
    "useTransition",
    "useDeferredValue",
    "useId",
    "useInsertionEffect",
  ];

  // Client 전용 Next.js 훅
  private static CLIENT_NEXT_HOOKS = [
    "useRouter",
    "usePathname",
    "useSearchParams",
    "useParams",
    "useSelectedLayoutSegment",
    "useSelectedLayoutSegments",
  ];

  // Server 전용 Next.js API
  private static SERVER_APIS = [
    "headers",
    "cookies",
    "draftMode",
    "notFound",
    "redirect",
    "permanentRedirect",
  ];

  // Server 전용 import 경로
  private static SERVER_IMPORTS = [
    "next/headers",
    "next/cache",
    "server-only",
  ];

  // Client 전용 import 경로
  private static CLIENT_IMPORTS = [
    "next/navigation",
    "client-only",
  ];

  /**
   * 파일명 기반 감지
   */
  private static detectFromFilename(filePath: string): {
    score: number;
    reason?: string;
  } {
    const basename = path.basename(filePath);

    // .client.tsx, .client.jsx
    if (/\.client\.(tsx|jsx)$/.test(basename)) {
      return { score: 100, reason: "파일명이 .client.tsx 패턴" };
    }

    // .server.tsx, .server.jsx
    if (/\.server\.(tsx|jsx)$/.test(basename)) {
      return { score: -100, reason: "파일명이 .server.tsx 패턴" };
    }

    return { score: 0 };
  }

  /**
   * 'use client' 지시문 감지
   */
  private static detectUseClientDirective(ast: t.File): {
    score: number;
    reason?: string;
  } {
    // 첫 번째 statement가 'use client'인지 확인
    const firstStatement = ast.program.body[0];

    if (
      firstStatement &&
      t.isExpressionStatement(firstStatement) &&
      t.isStringLiteral(firstStatement.expression)
    ) {
      const value = firstStatement.expression.value;
      if (value === "use client") {
        return { score: 100, reason: "'use client' 지시문 발견" };
      }
      if (value === "use server") {
        return { score: -100, reason: "'use server' 지시문 발견" };
      }
    }

    // Directive 형태로도 확인
    if (ast.program.directives && ast.program.directives.length > 0) {
      for (const directive of ast.program.directives) {
        if (directive.value.value === "use client") {
          return { score: 100, reason: "'use client' 지시문 발견" };
        }
        if (directive.value.value === "use server") {
          return { score: -100, reason: "'use server' 지시문 발견" };
        }
      }
    }

    return { score: 0 };
  }

  /**
   * Import 분석을 통한 감지
   */
  private static detectFromImports(ast: t.File): {
    clientScore: number;
    serverScore: number;
    reasons: string[];
  } {
    let clientScore = 0;
    let serverScore = 0;
    const reasons: string[] = [];

    traverse(ast, {
      ImportDeclaration: (path) => {
        const source = path.node.source.value;

        // Server 전용 import
        if (this.SERVER_IMPORTS.some((imp) => source.includes(imp))) {
          serverScore += 30;
          reasons.push(`서버 전용 import: ${source}`);
        }

        // Client 전용 import
        if (this.CLIENT_IMPORTS.some((imp) => source.includes(imp))) {
          clientScore += 30;
          reasons.push(`클라이언트 전용 import: ${source}`);
        }

        // Import된 함수/훅 확인
        path.node.specifiers.forEach((specifier) => {
          if (t.isImportSpecifier(specifier) && t.isIdentifier(specifier.imported)) {
            const importedName = specifier.imported.name;

            // Client 훅 import
            if (this.CLIENT_HOOKS.includes(importedName)) {
              clientScore += 20;
              reasons.push(`클라이언트 훅 import: ${importedName}`);
            }

            if (this.CLIENT_NEXT_HOOKS.includes(importedName)) {
              clientScore += 25;
              reasons.push(`클라이언트 Next.js 훅 import: ${importedName}`);
            }

            // Server API import
            if (this.SERVER_APIS.includes(importedName)) {
              serverScore += 25;
              reasons.push(`서버 API import: ${importedName}`);
            }
          }
        });
      },
    });

    return { clientScore, serverScore, reasons };
  }

  /**
   * 코드 사용 패턴 분석
   */
  private static detectFromUsage(ast: t.File): {
    clientScore: number;
    serverScore: number;
    reasons: string[];
  } {
    let clientScore = 0;
    let serverScore = 0;
    const reasons: string[] = [];

    traverse(ast, {
      CallExpression: (path) => {
        const callee = path.node.callee;

        // useState(), useEffect() 등 직접 호출
        if (t.isIdentifier(callee)) {
          if (this.CLIENT_HOOKS.includes(callee.name)) {
            clientScore += 15;
            reasons.push(`클라이언트 훅 사용: ${callee.name}()`);
          }

          if (this.CLIENT_NEXT_HOOKS.includes(callee.name)) {
            clientScore += 20;
            reasons.push(`클라이언트 Next.js 훅 사용: ${callee.name}()`);
          }

          if (this.SERVER_APIS.includes(callee.name)) {
            serverScore += 20;
            reasons.push(`서버 API 사용: ${callee.name}()`);
          }
        }
      },

      // onClick, onChange 등 이벤트 핸들러 (클라이언트 전용)
      JSXAttribute: (path) => {
        if (t.isJSXIdentifier(path.node.name)) {
          const attrName = path.node.name.name;
          if (/^on[A-Z]/.test(attrName)) {
            clientScore += 10;
            reasons.push(`이벤트 핸들러 발견: ${attrName}`);
          }
        }
      },

      // Next.js 서버 전용 export (generateMetadata, generateStaticParams 등)
      ExportNamedDeclaration: (path) => {
        if (
          path.node.declaration &&
          t.isFunctionDeclaration(path.node.declaration) &&
          path.node.declaration.id
        ) {
          const funcName = path.node.declaration.id.name;
          if (
            funcName === "generateMetadata" ||
            funcName === "generateStaticParams" ||
            funcName === "generateViewport"
          ) {
            serverScore += 30;
            reasons.push(`서버 전용 export: ${funcName}`);
          }
        }

        // export const dynamic = "force-static" 등
        if (
          path.node.declaration &&
          t.isVariableDeclaration(path.node.declaration)
        ) {
          path.node.declaration.declarations.forEach((declarator) => {
            if (
              t.isIdentifier(declarator.id) &&
              (declarator.id.name === "dynamic" ||
                declarator.id.name === "revalidate" ||
                declarator.id.name === "fetchCache" ||
                declarator.id.name === "runtime")
            ) {
              serverScore += 25;
              reasons.push(`서버 설정 export: ${declarator.id.name}`);
            }
          });
        }
      },
    });

    return { clientScore, serverScore, reasons };
  }

  /**
   * 파일을 분석하여 RSC 여부 판단
   */
  public static detect(
    ast: t.File,
    filePath: string
  ): DetectionResult {
    const reasons: string[] = [];
    let totalScore = 0;

    // 1. 파일명 기반 감지 (가장 확실한 힌트)
    const filenameResult = this.detectFromFilename(filePath);
    if (filenameResult.score !== 0) {
      totalScore += filenameResult.score;
      if (filenameResult.reason) {
        reasons.push(filenameResult.reason);
      }

      // 파일명이 명시적이면 바로 리턴
      if (Math.abs(filenameResult.score) === 100) {
        return {
          type: filenameResult.score > 0 ? "client" : "server",
          confidence: 100,
          reasons,
        };
      }
    }

    // 2. 'use client' / 'use server' 지시문 감지 (두 번째로 확실)
    const directiveResult = this.detectUseClientDirective(ast);
    if (directiveResult.score !== 0) {
      totalScore += directiveResult.score;
      if (directiveResult.reason) {
        reasons.push(directiveResult.reason);
      }

      // 지시문이 있으면 바로 리턴
      if (Math.abs(directiveResult.score) === 100) {
        return {
          type: directiveResult.score > 0 ? "client" : "server",
          confidence: 100,
          reasons,
        };
      }
    }

    // 3. Import 분석
    const importResult = this.detectFromImports(ast);
    totalScore += importResult.clientScore - importResult.serverScore;
    reasons.push(...importResult.reasons);

    // 4. 코드 사용 패턴 분석
    const usageResult = this.detectFromUsage(ast);
    totalScore += usageResult.clientScore - usageResult.serverScore;
    reasons.push(...usageResult.reasons);

    // 5. 점수 기반 최종 판정
    // totalScore > 0 이면 client, < 0 이면 server
    // totalScore === 0 이면 기본값은 server (Next.js App Router 기본 동작)

    const confidence = Math.min(
      100,
      Math.abs(totalScore) * 2 // 점수를 confidence로 변환
    );

    if (totalScore > 0) {
      return {
        type: "client",
        confidence: Math.max(60, confidence), // 최소 60% confidence
        reasons: reasons.length > 0 ? reasons : ["클라이언트 패턴 감지"],
      };
    } else if (totalScore < 0) {
      return {
        type: "server",
        confidence: Math.max(60, confidence),
        reasons: reasons.length > 0 ? reasons : ["서버 패턴 감지"],
      };
    } else {
      // 힌트가 없으면 기본적으로 서버 컴포넌트로 간주 (Next.js App Router 기본 동작)
      return {
        type: "server",
        confidence: 50, // 낮은 confidence
        reasons: ["힌트 없음 - Next.js App Router 기본값으로 서버 컴포넌트 간주"],
      };
    }
  }
}
