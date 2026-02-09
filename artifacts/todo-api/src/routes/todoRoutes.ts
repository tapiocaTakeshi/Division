import { Router, Request, Response } from 'express';
import { todoService } from '../services/todoService';
import { CreateTodoRequest, UpdateTodoRequest } from '../types/todo';

const router = Router();

/**
 * GET /todos
 * すべてのToDoアイテムを取得
 */
router.get('/todos', (req: Request, res: Response) => {
  const todos = todoService.getAllTodos();
  res.status(200).json(todos);
});

/**
 * GET /todos/:id
 * 特定のToDoアイテムを取得
 */
router.get('/todos/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID format' });
    return;
  }

  const todo = todoService.getTodoById(id);

  if (!todo) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }

  res.status(200).json(todo);
});

/**
 * POST /todos
 * 新しいToDoアイテムを作成
 */
router.post('/todos', (req: Request, res: Response) => {
  const { title } = req.body as CreateTodoRequest;

  // バリデーション
  if (!title || typeof title !== 'string' || title.trim() === '') {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  const newTodo = todoService.createTodo({ title: title.trim() });
  res.status(201).json(newTodo);
});

/**
 * PATCH /todos/:id
 * ToDoアイテムを更新
 */
router.patch('/todos/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID format' });
    return;
  }

  const { title, completed } = req.body as UpdateTodoRequest;

  // 少なくとも1つのフィールドが提供されているかチェック
  if (title === undefined && completed === undefined) {
    res.status(400).json({ error: 'At least one field (title or completed) must be provided' });
    return;
  }

  // バリデーション
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    res.status(400).json({ error: 'title must be a non-empty string' });
    return;
  }

  if (completed !== undefined && typeof completed !== 'boolean') {
    res.status(400).json({ error: 'completed must be a boolean' });
    return;
  }

  const updateData: UpdateTodoRequest = {};
  if (title !== undefined) updateData.title = title.trim();
  if (completed !== undefined) updateData.completed = completed;

  const updatedTodo = todoService.updateTodo(id, updateData);

  if (!updatedTodo) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }

  res.status(200).json(updatedTodo);
});

/**
 * DELETE /todos/:id
 * ToDoアイテムを削除
 */
router.delete('/todos/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID format' });
    return;
  }

  const deleted = todoService.deleteTodo(id);

  if (!deleted) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }

  res.status(204).send();
});

export default router;
