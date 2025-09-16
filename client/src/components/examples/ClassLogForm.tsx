import ClassLogForm from '../ClassLogForm';

export default function ClassLogFormExample() {
  // todo: remove mock functionality
  const mockClasses = [
    { id: "1", name: "영어 초급반" },
    { id: "2", name: "영어 중급반" },
    { id: "3", name: "수학 고급반" },
    { id: "4", name: "과학 실험반" }
  ];

  const handleSubmit = (log: any) => {
    console.log('Class log submitted:', log);
  };

  return (
    <div className="p-4">
      <ClassLogForm classes={mockClasses} onSubmit={handleSubmit} />
    </div>
  );
}