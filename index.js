// Jupyter hint coach extension v2 -- chained agent pipeline.
//
// Two LLM calls:
//   1. AGENT_LOCATOR_COACH receives the student notebook (Codio runtime
//      shape: {type, content, id} per cell, no nbgrader metadata) and emits
//      the TASKS_JSON array.
//   2. AGENT_COACH_V2 receives that array plus the guide page and emits a
//      hint after verifying tasks against NOTEBOOK_INSTRUCTOR_VIEW.
//
// All previous deterministic-locator JS has been removed -- it depended on
// nbgrader metadata that Codio's getContext() does not preserve at runtime.
(async function (codioIDE, window) {

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
      console.info("[Jupyter Hint v2] getContext:success", summarizeContext(context));

      const notebookContext = getNotebookContext(context);
      if (!notebookContext) {
        throw new Error("No open Jupyter notebook in context.");
      }

      const studentNotebook = notebookContext.content;
      const guideInstructions = getGuideInstructions(context);

      console.info("[Jupyter Hint v2] locator:start", {
        cellCount: Array.isArray(studentNotebook) ? studentNotebook.length : 0
      });
      const locatorResult = await codioIDE.coachBot.ask({
        systemPrompt: "You identify student tasks in a Jupyter notebook and emit them as a structured JSON array. Return only valid JSON.",
        userPrompt: "{% prompt 'AGENT_LOCATOR_COACH' %}",
        vars: {
          STUDENT_NOTEBOOK: JSON.stringify(studentNotebook)
        }
      }, { stream: false, preventMenu: true });
      const tasks = parseLocatorTasks(locatorResult);
      console.info("[Jupyter Hint v2] locator:success", summarizeTasks(tasks));

      if (tasks.length === 0) {
        throw new Error("Locator returned zero tasks. Cannot proceed.");
      }

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
      const parsed = parseCoachResponse(coachResult);
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
  // LLM response parsing
  // ---------------------------------------------------------------------------

  function parseLocatorTasks(result) {
    const raw = result && typeof result.result === "string" ? result.result : "";
    const extracted = extractJsonValue(raw, "array");
    if (!extracted) {
      throw new Error("Unable to extract JSON array from locator result.");
    }
    let parsed;
    try {
      parsed = JSON.parse(extracted);
    } catch (error) {
      console.error("[Jupyter Hint v2] locator:json-parse-failed", {
        message: error && error.message ? error.message : null,
        preview: raw.slice(0, 400)
      });
      throw error;
    }
    // Some models wrap arrays in {tasks: [...]} despite the schema; accept either.
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    throw new Error("Locator response is not a JSON array.");
  }

  function parseCoachResponse(result) {
    const raw = result && typeof result.result === "string" ? result.result : "";
    const extracted = extractJsonValue(raw, "object");
    if (!extracted) {
      throw new Error("Unable to extract JSON object from coach result.");
    }
    try {
      return JSON.parse(extracted);
    } catch (error) {
      console.error("[Jupyter Hint v2] coach:json-parse-failed", {
        message: error && error.message ? error.message : null,
        preview: raw.slice(0, 400)
      });
      throw error;
    }
  }

  function extractJsonValue(raw, kind) {
    if (!raw || typeof raw !== "string") return null;
    const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch && fencedMatch[1]) {
      return fencedMatch[1].trim();
    }
    const open = kind === "array" ? "[" : "{";
    const close = kind === "array" ? "]" : "}";
    const first = raw.indexOf(open);
    const last = raw.lastIndexOf(close);
    if (first !== -1 && last !== -1 && last > first) {
      return raw.slice(first, last + 1).trim();
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
      count: Array.isArray(tasks) ? tasks.length : 0,
      tasks: (Array.isArray(tasks) ? tasks : []).map(function (t) {
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
