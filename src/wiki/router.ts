import { Router } from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { WikiStore } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createWikiRouter(store: WikiStore): Router {
  const router = Router();

  // === Articles ===

  router.get("/api/wiki/articles", async (req, res) => {
    try {
      const category = req.query.category as string | undefined;
      const search = req.query.search as string | undefined;
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const result = await store.listArticles(category, search, page, limit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/wiki/articles", async (req, res) => {
    try {
      const { title, contentMd, summary, categoryId, tags, status } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: "Title is required" });
      if (!contentMd || !contentMd.trim()) return res.status(400).json({ error: "Content is required" });
      const article = await store.createArticle({ title, contentMd, summary, categoryId, tags, status });
      res.status(201).json(article);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/wiki/articles/:id", async (req, res) => {
    try {
      const article = await store.getArticle(req.params.id);
      if (!article) return res.status(404).json({ error: "Article not found" });
      res.json(article);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/wiki/articles/:id", async (req, res) => {
    try {
      const article = await store.updateArticle(req.params.id, req.body);
      if (!article) return res.status(404).json({ error: "Article not found" });
      res.json(article);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/wiki/articles/:id", async (req, res) => {
    try {
      const deleted = await store.deleteArticle(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Article not found" });
      res.json({ deleted: req.params.id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/wiki/articles/:id/revisions", async (req, res) => {
    try {
      const revisions = await store.getRevisions(req.params.id);
      res.json(revisions);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Categories ===

  router.get("/api/wiki/categories", async (_req, res) => {
    try {
      const categories = await store.listCategories();
      res.json(categories);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/wiki/categories", async (req, res) => {
    try {
      const { name, description, parentId, sortOrder } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: "Category name is required" });
      const category = await store.createCategory({ name, description, parentId, sortOrder });
      res.status(201).json(category);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/wiki/categories/:id", async (req, res) => {
    try {
      const category = await store.updateCategory(req.params.id, req.body);
      if (!category) return res.status(404).json({ error: "Category not found" });
      res.json(category);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/wiki/categories/:id", async (req, res) => {
    try {
      await store.deleteCategory(req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if ((err as Error).message.includes("subcategories")) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Serve wiki pages ===
  router.get("/wiki", (_req, res) => {
    res.sendFile(join(__dirname, "..", "server", "public", "wiki.html"));
  });

  router.get("/wiki/edit", (_req, res) => {
    res.sendFile(join(__dirname, "..", "server", "public", "wiki-edit.html"));
  });

  router.get("/wiki/article", (_req, res) => {
    res.sendFile(join(__dirname, "..", "server", "public", "wiki-article.html"));
  });

  return router;
}
