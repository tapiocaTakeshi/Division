import express, { Application } from 'express';
import todoRoutes from './routes/todoRoutes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

const app: Application = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ログミドルウェア（開発用）
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ルート設定
app.use('/api', todoRoutes);

// ヘルスチェックエンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 404ハンドラー
app.use(notFoundHandler);

// エラーハンドラー
app.use(errorHandler);

// サーバー起動
app.listen(PORT, () => {
  console.log(`ToDo API Server is running on port ${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/api/todos`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export default app;
