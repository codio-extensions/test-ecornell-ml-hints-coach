// Jupyter hint coach extension v2 -- deterministic locator + single LLM call.
// Replaces the three-step pipeline in extension_code.js with one round trip.
(async function (codioIDE, window) {

  const STUDENT_BEGIN = "# YOUR CODE HERE";
  const STUDENT_END = "# END OF YOUR CODE";

  // The instructor solution notebook is NOT readable from the extension at
  // runtime. Codio injects it server-side as the NOTEBOOK_INSTRUCTOR_VIEW
  // placeholder when the prompt is sent. The deterministic locator below
  // therefore runs on the student notebook alone; the prompt aligns each
  // task to the solution by grade_id.

  const DEF_RE = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m;
  const RAISE_NOT_IMPL_RE = /^\s*raise\s+NotImplementedError\s*\(.*\)\s*$/;

  codioIDE.coachBot.register(
    "customHintsJupyterMLv2",
    "ML hint button (v2)",
    onButtonPress
  );

  async function onButtonPress() {
    codioIDE.coachBot.showThinkingAnimation();

    try {
      console.info("[Jupyter Hint v2] getContext:start");
      const context = await codioIDE.coachBot.getContext();
      console.log("context", context)
      console.info("[Jupyter Hint v2] getContext:success", summarizeContext(context));

      const notebookContext = getNotebookContext(context);
      if (!notebookContext) {
        throw new Error("No open Jupyter notebook in context.");
      }

      const studentNotebook = notebookContext.content;
      const guideInstructions = getGuideInstructions(context);

      console.info("[Jupyter Hint v2] locate:start");
      const tasks = locateTasks(studentNotebook);
      console.info("[Jupyter Hint v2] locate:success", summarizeTasks(tasks));

      console.info("[Jupyter Hint v2] coach:start", {
        taskCount: tasks.length,
        guideInstructionChars: guideInstructions.length
      });
      const coachResult = await codioIDE.coachBot.ask({
        systemPrompt: "You analyze pre-located notebook tasks, select one, classify it, and produce a single hint. Return only valid JSON.",
        userPrompt: "{% prompt 'AGENT_COACH_V2' %}",
        vars: {
          TASKS_JSON: JSON.stringify(tasks),
          GUIDE_INSTRUCTIONS: guideInstructions
        }
      }, { stream: false, preventMenu: true });
      const parsed = normalizeCoachJson(coachResult, "coach");
      console.info("[Jupyter Hint v2] coach:success", summarizeCoachJson(parsed));

      const hintText = typeof parsed.hint === "string" ? parsed.hint : "";
      if (!hintText) {
        throw new Error("Coach response is missing the 'hint' field.");
      }

      codioIDE.coachBot.hideThinkingAnimation();
      codioIDE.coachBot.write(hintText);
      codioIDE.coachBot.showMenu();
    } catch (error) {
      handlePipelineError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Deterministic locator -- ports eCornell-Coach-Evals/eval/locate.py
  // ---------------------------------------------------------------------------

  function locateTasks(studentNb) {
    const studentCells = normalizeCells(studentNb);
    const tasks = [];

    for (let i = 0; i < studentCells.length; i++) {
      const cell = studentCells[i];
      if (cell.cell_type !== "code") continue;
      const nbgrader = (cell.metadata && cell.metadata.nbgrader) || {};
      if (!nbgrader.solution) continue;
      const gradeId = nbgrader.grade_id;
      if (!gradeId) continue;

      const studentSrc = cellSource(cell);
      const studentZone = extractWorkZone(studentSrc, STUDENT_BEGIN, STUDENT_END, gradeId, "student");

      tasks.push({
        id: gradeId,
        title: inferTitle(studentSrc, gradeId),
        student_cell_index: i,
        student_work_zone: studentZone,
        status: classifyStatus(studentZone)
      });
    }

    return tasks;
  }

  function normalizeCells(nb) {
    if (!nb) return [];
    const raw = Array.isArray(nb) ? nb : Array.isArray(nb.cells) ? nb.cells : [];
    return raw.map(function (cell) {
      return {
        cell_type: cell.cell_type || cell.type || null,
        source: cell.source,
        metadata: cell.metadata || {}
      };
    });
  }

  function cellSource(cell) {
    const src = cell && cell.source !== undefined ? cell.source : "";
    if (Array.isArray(src)) return src.join("");
    return typeof src === "string" ? src : "";
  }

  function extractWorkZone(source, startMarker, endMarker, gradeId, kind) {
    const lines = (source || "").split("\n");
    let beginIdx = null;
    let endIdx = null;
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (beginIdx === null && stripped === startMarker) {
        beginIdx = i;
      } else if (beginIdx !== null && stripped === endMarker) {
        endIdx = i;
        break;
      }
    }
    if (beginIdx === null) {
      throw new Error("Missing " + kind + " begin marker '" + startMarker + "' in cell " + gradeId);
    }
    if (endIdx === null) {
      throw new Error("Missing " + kind + " end marker '" + endMarker + "' in cell " + gradeId);
    }
    return lines.slice(beginIdx + 1, endIdx).join("\n");
  }

  function inferTitle(source, gradeId) {
    const m = (source || "").match(DEF_RE);
    return m ? m[1] : gradeId;
  }

  function classifyStatus(workZone) {
    const lines = (workZone || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const stripped = raw.trim();
      if (!stripped) continue;
      if (stripped.startsWith("#")) continue;
      if (stripped === "pass") continue;
      if (RAISE_NOT_IMPL_RE.test(raw)) continue;
      return "HAS_ATTEMPTED";
    }
    return "NOT_STARTED";
  }

  // ---------------------------------------------------------------------------
  // Codio context helpers
  // ---------------------------------------------------------------------------

  function getNotebookContext(context) {
    if (context && Array.isArray(context.jupyterContext) && context.jupyterContext.length > 0) {
      return context.jupyterContext[0];
    }
    return null;
  }

  function getGuideInstructions(context) {
    if (context && context.guidesPage && typeof context.guidesPage.content === "string") {
      return context.guidesPage.content;
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Coach response handling
  // ---------------------------------------------------------------------------

  function normalizeCoachJson(result, label) {
    const raw = result && typeof result.result === "string" ? result.result : "";
    const extracted = extractJsonObject(raw);
    if (!extracted) {
      throw new Error("Unable to extract JSON from " + label + " result.");
    }
    try {
      const parsed = JSON.parse(extracted);
      console.info("[Jupyter Hint v2] " + label + ":normalized", {
        rawChars: raw.length,
        jsonChars: JSON.stringify(parsed).length
      });
      return parsed;
    } catch (error) {
      console.error("[Jupyter Hint v2] " + label + ":json-parse-failed", {
        message: error && error.message ? error.message : null,
        preview: raw.slice(0, 400)
      });
      throw error;
    }
  }

  function extractJsonObject(raw) {
    if (!raw || typeof raw !== "string") return null;
    const fencedMatch = raw.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fencedMatch && fencedMatch[1]) {
      return fencedMatch[1].trim();
    }
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return raw.slice(firstBrace, lastBrace + 1).trim();
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Logging summaries
  // ---------------------------------------------------------------------------

  function summarizeContext(context) {
    return {
      hasJupyterContext: !!(context && Array.isArray(context.jupyterContext) && context.jupyterContext.length > 0),
      jupyterContextCount: context && Array.isArray(context.jupyterContext) ? context.jupyterContext.length : 0,
      hasGuidesPage: !!(context && context.guidesPage),
      guideTitle: context && context.guidesPage ? context.guidesPage.title || null : null
    };
  }

  function summarizeTasks(tasks) {
    return {
      count: tasks.length,
      tasks: tasks.map(function (t) {
        return { id: t.id, title: t.title, status: t.status };
      })
    };
  }

  function summarizeCoachJson(parsed) {
    const selected = parsed && parsed.selected_task ? parsed.selected_task : null;
    return {
      classification: parsed && parsed.classification ? parsed.classification : null,
      selectedTaskId: selected ? selected.id || null : null,
      selectedTaskTitle: selected ? selected.title || null : null,
      hintChars: parsed && typeof parsed.hint === "string" ? parsed.hint.length : 0
    };
  }

  function handlePipelineError(error) {
    console.error("[Jupyter Hint v2] pipeline:error", {
      message: error && error.message ? error.message : null,
      name: error && error.name ? error.name : null,
      stack: error && error.stack ? error.stack : null,
      raw: error
    });
    codioIDE.coachBot.hideThinkingAnimation();
    codioIDE.coachBot.write("I'm having trouble analyzing your notebook right now. Please try clicking the hint button again.");
    codioIDE.coachBot.showMenu();
  }
})(window.codioIDE, window);
