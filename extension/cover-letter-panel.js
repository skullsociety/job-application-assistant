"use strict";

const CoverLetterPanel = (() => {
  const output = document.querySelector("#letter-output");
  const copy = document.querySelector("#copy-letter");
  const location = document.querySelector("#letter-location");
  let jobId = null;

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      copy.textContent = "Copied!";
      setTimeout(() => { copy.textContent = "Copy cover letter"; }, 2000);
    } catch (_) {
      output.focus();
      output.select();
      copy.textContent = "Select and copy the highlighted text";
    }
  });

  return {
    setJob(id) {
      if (jobId === id) return;
      jobId = id;
      output.value = "";
      output.hidden = true;
      copy.hidden = true;
      copy.textContent = "Copy cover letter";
      location.textContent = "";
    },
    show(letter, filePath, expectedJobId) {
      if (jobId !== expectedJobId) return;
      output.value = letter;
      output.hidden = false;
      copy.hidden = false;
      location.textContent = filePath ? `Saved on this computer: ${filePath}` : "";
    },
  };
})();
