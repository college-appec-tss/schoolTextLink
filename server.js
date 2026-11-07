
require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function sendJSON(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

// Serialize feedback updates within this server process.
let saveQueue = Promise.resolve();

const allowedAnswers = {
    nameOpinion: [
        "I love the name",
        "It is a good name",
        "It is okay",
        "It could be better",
        "I do not like the name"
    ],

    nameMeaning: [
        "Yes, definitely",
        "Somewhat",
        "Not sure",
        "No"
    ],

    firstImpression: [
        "Very professional",
        "Modern and attractive",
        "Simple and clear",
        "Average",
        "Needs improvement"
    ],

    purpose: [
        "Yes, clearly",
        "I understand most of it",
        "I am a little confused",
        "No, I do not understand"
    ],

    usefulness: [
        "Extremely useful",
        "Very useful",
        "Somewhat useful",
        "Not very useful",
        "Not useful at all"
    ],

    designOpinion: [
        "Excellent design",
        "Very attractive",
        "Simple and clean",
        "Average design",
        "Needs improvement"
    ],

    favoriteFeature: [
        "Student-to-parent messaging",
        "Web-based access",
        "SMS notifications",
        "Simple interface",
        "The overall idea",
        "Other"
    ]
};

function validateFeedback(data) {
    const rating = Number(data.rating);

    if (
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 5
    ) {
        throw new Error("Choose a rating from 1 to 5.");
    }

    const fields = [
        "nameOpinion",
        "nameMeaning",
        "firstImpression",
        "purpose",
        "usefulness",
        "designOpinion",
        "favoriteFeature"
    ];

    for (const field of fields) {
        if (
            typeof data[field] !== "string" ||
            !allowedAnswers[field].includes(data[field])
        ) {
            throw new Error(`Please provide a valid answer for ${field}.`);
        }
    }

    const improvements =
        typeof data.improvements === "string"
            ? data.improvements.trim()
            : "";

    const comments =
        typeof data.comments === "string"
            ? data.comments.trim()
            : "";

    if (improvements.length > 1000 || comments.length > 1000) {
        throw new Error("Written feedback must be under 1000 characters.");
    }

    return {
        rating,
        nameOpinion: data.nameOpinion,
        nameMeaning: data.nameMeaning,
        firstImpression: data.firstImpression,
        purpose: data.purpose,
        usefulness: data.usefulness,
        designOpinion: data.designOpinion,
        favoriteFeature: data.favoriteFeature,
        improvements,
        comments
    };
}

async function saveFeedback(data) {
    const task = saveQueue.then(async () => {

        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            throw new Error("GitHub configuration is missing.");
        }

        const apiURL =
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/feedback.json`;

        const headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${GITHUB_TOKEN}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "SchoolText-Link"
        };

        // Get current GitHub feedback file.
        const getResponse = await fetch(
            `${apiURL}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
            { headers }
        );

        if (!getResponse.ok) {
            throw new Error(
                `Could not read feedback.json: ${getResponse.status}`
            );
        }

        const file = await getResponse.json();

        if (!file.content || !file.sha) {
            throw new Error("Invalid GitHub feedback file.");
        }

        let feedback;

        try {
            feedback = JSON.parse(
                Buffer.from(
                    file.content.replace(/\n/g, ""),
                    "base64"
                ).toString("utf8")
            );
        } catch {
            throw new Error("Existing feedback.json contains invalid JSON.");
        }

        if (!Number.isInteger(feedback.totalResponses)) {
            feedback.totalResponses = 0;
        }

        if (!feedback.ratingCounts) {
            feedback.ratingCounts = {};
        }

        for (let i = 1; i <= 5; i++) {
            if (!Number.isInteger(feedback.ratingCounts[String(i)])) {
                feedback.ratingCounts[String(i)] = 0;
            }
        }

        if (!Array.isArray(feedback.submissions)) {
            feedback.submissions = [];
        }

        // Create a complete anonymous submission.
        const submission = {
            id: crypto.randomUUID(),
            ...data,
            submittedAt: new Date().toISOString()
        };

        feedback.submissions.push(submission);

        // Update statistics.
        feedback.totalResponses += 1;
        feedback.ratingCounts[String(data.rating)] += 1;
        feedback.lastUpdated = submission.submittedAt;

        const newContent = Buffer.from(
            JSON.stringify(feedback, null, 2)
        ).toString("base64");

        // Save updated file to GitHub.
        const updateResponse = await fetch(apiURL, {
            method: "PUT",
            headers,
            body: JSON.stringify({
                message: "Save SchoolText Link feedback",
                content: newContent,
                sha: file.sha,
                branch: GITHUB_BRANCH
            })
        });

        if (!updateResponse.ok) {
            const error = await updateResponse.json();

            throw new Error(
                error.message || "GitHub update failed."
            );
        }

        return submission;
    });

    saveQueue = task.catch(() => {});

    return task;
}

// Create HTTP server.
const server = http.createServer((req, res) => {

    // FEEDBACK API
    if (req.method === "POST" && req.url === "/api/feedback") {

        let body = "";
        let tooLarge = false;

        req.on("data", chunk => {
            body += chunk;

            if (Buffer.byteLength(body) > 15000) {
                tooLarge = true;
                req.destroy();
            }
        });

        req.on("end", async () => {

            if (tooLarge) {
                return sendJSON(res, 413, {
                    success: false,
                    message: "Request too large."
                });
            }

            try {
                const data = JSON.parse(body);

                const validatedData = validateFeedback(data);

                const submission = await saveFeedback(validatedData);

                return sendJSON(res, 200, {
                    success: true,
                    message: "Thank you! Your feedback was saved successfully.",
                    submissionId: submission.id
                });

            } catch (error) {
                console.error("Feedback error:", error);

                return sendJSON(res, 500, {
                    success: false,
                    message: error.message || "Unable to save feedback."
                });
            }
        });

        return;
    }

    // SERVE WEBSITE FILES
    if (req.method === "GET") {

        let pathname;

        try {
            pathname = new URL(
                req.url,
                "http://localhost"
            ).pathname;

            pathname = decodeURIComponent(pathname);
        } catch {
            return sendJSON(res, 400, {
                message: "Invalid URL."
            });
        }

        const requestedFile = pathname === "/"
            ? "index.html"
            : pathname.slice(1);

        const filePath = path.resolve(
            PUBLIC_DIR,
            requestedFile
        );

        if (
            !filePath.startsWith(PUBLIC_DIR + path.sep) &&
            filePath !== path.join(PUBLIC_DIR, "index.html")
        ) {
            return sendJSON(res, 403, {
                message: "Access denied."
            });
        }

        const contentTypes = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".webp": "image/webp",
            ".ico": "image/x-icon"
            ".txt": "text/plain; charset=utf-8",
".xml": "application/xml; charset=utf-8",
        };

        fs.readFile(filePath, (error, content) => {

            if (error) {
                res.writeHead(404);
                return res.end("Page not found.");
            }

            res.writeHead(200, {
                "Content-Type":
                    contentTypes[path.extname(filePath)] ||
                    "application/octet-stream",
                "X-Content-Type-Options": "nosniff"
            });

            res.end(content);
        });

        return;
    }

    sendJSON(res, 404, {
        message: "Route not found."
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`SchoolText Link running on port ${PORT}`);
});
