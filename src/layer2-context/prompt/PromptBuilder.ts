// ═══════════════════════════════════════════════════════════════
// Prompt Builder — Generates structured prompts for local AI model
// ═══════════════════════════════════════════════════════════════

import { RetrievedContext, ChatMessage, ContextQuery } from '../../shared/types/context.types';
import { BuiltPrompt, PromptTemplate } from '../../shared/types/prompt.types';
import { estimateTokens } from '../../shared/utils/tokenCounter';

export class PromptBuilder {
  /**
   * Build a fully formatted system prompt, context files, and message history
   * for the local reasoning model.
   */
  build(
    query: ContextQuery,
    context: RetrievedContext,
    templateType: PromptTemplate
  ): BuiltPrompt {
    const systemPrompt = this.getSystemPrompt(templateType, context);
    
    // Format context files into a readable Markdown list
    let contextContent = this.formatContext(context);

    // Dynamic duplicate detection fallback
    const queryLower = query.userMessage.toLowerCase();
    if (queryLower.includes('duplicate') || queryLower.includes('duplication')) {
      try {
        const container = require('../../container').ServiceContainer.getInstance() as any;
        const duplicateSymbols = container.database.query(
          `SELECT name, COUNT(*) as cnt FROM symbols 
           WHERE name NOT IN ('', 'default', 'anonymous', 'const', 'let', 'var', 'onClick', 'onChange', 'onSubmit', 'render') 
           GROUP BY name HAVING cnt > 1 ORDER BY cnt DESC LIMIT 15`
        ) as Array<{ name: string; cnt: number }>;
        if (duplicateSymbols.length > 0) {
          contextContent += '\n\n### DETECTED DUPLICATE FUNCTIONS & METHODS IN CODEBASE\n';
          for (const sym of duplicateSymbols) {
            const occurrences = container.database.query(
              `SELECT f.relative_path, s.start_line FROM symbols s 
               JOIN files f ON s.file_id = f.id 
               WHERE s.name = ? LIMIT 5`,
              [sym.name]
            ) as Array<{ relative_path: string; start_line: number }>;
            contextContent += `- Symbol name: \`${sym.name}\` (defined ${sym.cnt} times)\n`;
            for (const occ of occurrences) {
              contextContent += `  - File: \`${occ.relative_path}\` (line ${occ.start_line})\n`;
            }
          }
        }
      } catch (err) {
        // Safe fallback if container or query fails
      }
    }
    
    // Construct the actual message list sent to the LLM API
    const messages: ChatMessage[] = [];
    
    // Append conversation history
    if (query.conversationHistory) {
      messages.push(...query.conversationHistory);
    }
    
    // Create the final message containing the user prompt and context
    const userMessageContent = `
[CONTEXT FILES]
${contextContent}

[USER QUESTION]
${query.userMessage}
    `.trim();

    messages.push({
      role: 'user',
      content: userMessageContent,
      timestamp: Date.now(),
    });

    const originalTokens = estimateTokens(query.userMessage) + (query.conversationHistory?.reduce((acc, m) => acc + estimateTokens(m.content), 0) ?? 0);
    const totalEstimated = estimateTokens(systemPrompt) + estimateTokens(userMessageContent);

    // Context summary for debugging/logs
    const contextSummary = `Files included: ${context.files.length}, Symbols included: ${context.symbols.length}, Conventions: ${context.conventions.length}`;

    return {
      system: systemPrompt,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: Date.now() },
        ...messages
      ],
      estimatedTokens: totalEstimated,
      contextSummary,
      metadata: {
        template: templateType,
        filesIncluded: context.files.length,
        symbolsIncluded: context.symbols.length,
        conventionsIncluded: context.conventions.length,
        truncated: false,
        originalTokens,
        optimizedTokens: totalEstimated,
      },
    };
  }

  private getSystemPrompt(template: PromptTemplate, context: RetrievedContext): string {
    const framework = context.framework;
    const conventions = context.conventions.map(c => `- [${c.category.toUpperCase()}] ${c.rule}`).join('\n');

    const basePrompt = `
You are a Principal Software Architect and Senior Developer specializing in ${framework.primary || 'fullstack software design'}.
You are interacting offline-first with the Repository Intelligence Engine which scans and analyzes the codebase.

[PROJECT FRAMEWORK & CONVENTIONS]
- Primary framework: ${framework.primary} ${framework.version ? `(v${framework.version})` : ''}
- Sub-routers: ${framework.router}
- State management: ${framework.stateManagement.join(', ') || 'None detected'}
- Styling system: ${framework.styling.join(', ') || 'None detected'}
- Testing framework: ${framework.testing.join(', ') || 'None detected'}
- ORM/Database: ${framework.orm || 'None detected'}

[CODING CONVENTIONS INFERRED FROM CODEBASE]
${conventions || 'No specific style rules found.'}

[CODE EDITING FORMAT]
1. Write code adhering strictly to the conventions and libraries listed above.
2. When proposing changes to EXISTING files, use SEARCH/REPLACE blocks. Do NOT output the entire file.
   Format:
   path/to/file.tsx
   <<<<<<< SEARCH
   exact original lines to find
   =======
   replacement lines
   >>>>>>> REPLACE

   Rules:
   - The SEARCH section MUST exactly match existing lines in the file (including whitespace and indentation)
   - Only include the minimal lines needed for context, never the entire file
   - You may output multiple SEARCH/REPLACE blocks for multiple edits
3. For creating NEW files only, use a code block with the filepath:
   \`\`\`language:path/to/new-file.tsx
   // full file content
   \`\`\`
    `.trim();

    switch (template) {
      case 'code-generation':
        return `${basePrompt}\n\nTask: Generate functional, optimized, and type-safe code based on the files provided in [CONTEXT FILES]. Always return markdown code blocks with the appropriate language type. Keep explanations minimal and focus on functional correctness.`;
      case 'code-review':
        return `${basePrompt}\n\nTask: Review the provided code files for bugs, security vulnerabilities, memory leaks, and stylistic inconsistencies. Highlight specific line numbers and suggest concrete refactoring fixes.`;
      case 'refactor':
        return `${basePrompt}\n\nTask: Refactor the provided code block. Optimize performance, readability, and structural modularity. Retain typescript signatures and avoid regressions.`;
      case 'explain':
        return `${basePrompt}\n\nTask: Explain the files and architectural relationships. Detail the control flow and state propagation where appropriate.`;
      case 'architecture':
        return `${basePrompt}\n\nTask: Walk through structural changes or architectural suggestions. Detail how new files should fit into the existing folders.`;
      default:
        return `${basePrompt}\n\nTask: Assist the user with code generation, explanations, and repository understanding.`;
    }
  }

  private formatContext(context: RetrievedContext): string {
    if (context.files.length === 0) return 'No context files matched.';

    return context.files
      .map(f => {
        // Add line numbers to help LLM reference exact lines for SEARCH blocks
        const numbered = f.content
          .split('\n')
          .map((line, i) => `${i + 1}: ${line}`)
          .join('\n');

        return `
--- FILE: ${f.relativePath} ---
\`\`\`
${numbered}
\`\`\`
--- END ---
      `.trim();
      })
      .join('\n\n');
  }
}
