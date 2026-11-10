// Stand-in for jsPDF's optional dependencies (html2canvas, dompurify, canvg). They serve
// jsPDF.html() and SVG images, which this project does not use, so the build leaves them out.
export default function unavailable() { throw new Error('This jsPDF feature is not included in the build'); }
