import { Todo, CreateTodoRequest, UpdateTodoRequest } from '../types/todo';

/**
 * ToDoサービスクラス
 * インメモリでToDoデータを管理
 */
class TodoService {
  private todos: Todo[] = [];
  private nextId: number = 1;

  /**
   * すべてのToDoアイテムを取得
   */
  getAllTodos(): Todo[] {
    return [...this.todos]; // 配列のコピーを返す
  }

  /**
   * IDでToDoアイテムを検索
   */
  getTodoById(id: number): Todo | undefined {
    return this.todos.find(todo => todo.id === id);
  }

  /**
   * 新しいToDoアイテムを作成
   */
  createTodo(data: CreateTodoRequest): Todo {
    const now = new Date();
    const newTodo: Todo = {
      id: this.nextId++,
      title: data.title,
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    this.todos.push(newTodo);
    return newTodo;
  }

  /**
   * ToDoアイテムを更新
   */
  updateTodo(id: number, data: UpdateTodoRequest): Todo | null {
    const todoIndex = this.todos.findIndex(todo => todo.id === id);

    if (todoIndex === -1) {
      return null;
    }

    const existingTodo = this.todos[todoIndex];
    const updatedTodo: Todo = {
      ...existingTodo,
      title: data.title !== undefined ? data.title : existingTodo.title,
      completed: data.completed !== undefined ? data.completed : existingTodo.completed,
      updatedAt: new Date(),
    };

    this.todos[todoIndex] = updatedTodo;
    return updatedTodo;
  }

  /**
   * ToDoアイテムを削除
   */
  deleteTodo(id: number): boolean {
    const todoIndex = this.todos.findIndex(todo => todo.id === id);

    if (todoIndex === -1) {
      return false;
    }

    this.todos.splice(todoIndex, 1);
    return true;
  }

  /**
   * すべてのToDoアイテムを削除（テスト用）
   */
  clearAllTodos(): void {
    this.todos = [];
    this.nextId = 1;
  }
}

// シングルトンインスタンスをエクスポート
export const todoService = new TodoService();
