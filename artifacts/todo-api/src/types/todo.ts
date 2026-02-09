/**
 * ToDoアイテムのインターフェース定義
 */
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * ToDo作成時のリクエストボディの型
 */
export interface CreateTodoRequest {
  title: string;
}

/**
 * ToDo更新時のリクエストボディの型
 */
export interface UpdateTodoRequest {
  title?: string;
  completed?: boolean;
}

/**
 * エラーレスポンスの型
 */
export interface ErrorResponse {
  error: string;
}
