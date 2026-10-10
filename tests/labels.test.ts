import { test } from "node:test";
import assert from "node:assert/strict";
import { subjectLines } from "../src/services/reportLabels.js";

const L = (project: string, board: string, column: string) => ({ project, board, column });

test("Есеп жолдары: пән бір жолда, YouGile атауы емес", () => {
  const lines = subjectLines([
    { trace: { title: "a", location: L("Marketing", "Пән акк", "Химия") }, items: { Пост: 1, Карусель: 8 } },
    { trace: { title: "b", location: L("Marketing", "Пән акк", "Химия") }, items: { Пост: 2, Карусель: 2 } },
    { trace: { title: "c", location: L("Product", "YouTube", "Обложка") }, items: { "YouTube обложка": 4 } },
    { trace: { title: "Физика курсына таргет", location: L("Design", "Т", "өз тз") }, items: { "Таргет баннер": 2 } },
    { trace: { title: "Ұстаздар күні", location: L("HR", "Т", "тз") }, items: { Баннер: 2 } },
  ]);
  assert.deepEqual(lines, ["Химия — 3 пост, 10 карусель", "YouTube — 4 обложка", "Физика — 2 таргет баннер", "HR — 2 баннер"]);
});
